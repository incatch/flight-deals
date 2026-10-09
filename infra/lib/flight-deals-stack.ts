import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2Actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";

export interface FlightDealsStackProps extends cdk.StackProps {
  /** The domain whose Route 53 hosted zone we add records to, e.g. plopza.com */
  domainName: string;
  hostedZoneId: string;
  /** Where the site is served, e.g. flights.plopza.com */
  siteDomain: string;
  /** Always an admin, so the owner can't be locked out */
  ownerEmail: string;
  /** The time zone scans and the weekly email run in */
  timeZone: string;
}

/**
 * The flight deals site. To save money it shares ticket-hub's network, load
 * balancer and database server (see incatch/ticket-hub, which publishes
 * them under /household/shared/ in Parameter Store), like the glamping back
 * office and the raffle site:
 *
 *   flights.plopza.com ──HTTPS──► ticket-hub's load balancer ──► flight deals container (Fargate)
 *                                 (/admin: household sign-in)       │        │
 *                                                                   │        └──► Travelpayouts, Google Flights (SerpApi)
 *                                                                   ▼
 *                                          "flights" database on ticket-hub's database server
 *
 * The public pages (sign-up, the links in emails) need no sign-in; Admin
 * asks for the household sign-in at the load balancer.
 */
export class FlightDealsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FlightDealsStackProps) {
    super(scope, id, props);

    // Values ticket-hub publishes; read when this is deployed.
    const shared = (name: string) => ssm.StringParameter.valueForStringParameter(this, `/household/shared/${name}`);
    const siteUrl = `https://${props.siteDomain}`;

    // ── ticket-hub's network ─────────────────────────────────────────────
    const subnetIds = cdk.Fn.split(",", shared("public-subnet-ids"), 2);
    // (The shared subnets' route tables aren't needed here.)
    cdk.Annotations.of(this).acknowledgeWarning("@aws-cdk/aws-ec2:noSubnetRouteTableId");
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Network", {
      vpcId: shared("vpc-id"),
      availabilityZones: ["us-east-2a", "us-east-2b"],
      publicSubnetIds: [cdk.Fn.select(0, subnetIds), cdk.Fn.select(1, subnetIds)],
    });

    // ── Domain and HTTPS certificate ─────────────────────────────────────
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.siteDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // ── ticket-hub's load balancer ───────────────────────────────────────
    // Read-only here (as in glamping): the one rule we need, to reach our
    // website, is added explicitly below.
    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, "LoadBalancerFirewall", shared("alb-security-group-id"), {
      mutable: false,
    });
    const loadBalancer = elbv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(this, "LoadBalancer", {
      loadBalancerArn: shared("alb-arn"),
      securityGroupId: albSecurityGroup.securityGroupId,
      loadBalancerDnsName: shared("alb-dns-name"),
      loadBalancerCanonicalHostedZoneId: shared("alb-zone-id"),
    });
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, "HttpsListener", {
      listenerArn: shared("https-listener-arn"),
      securityGroup: albSecurityGroup,
    });
    new elbv2.ApplicationListenerCertificate(this, "ListenerCertificate", {
      listener,
      certificates: [elbv2.ListenerCertificate.fromCertificateManager(certificate)],
    });
    new route53.ARecord(this, "SiteAddress", {
      zone,
      recordName: props.siteDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancer)),
    });

    // ── Keys and secrets ─────────────────────────────────────────────────
    // ticket-hub's database server login. The site keeps its data in its own
    // database ("flights") on that server, created on first start.
    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "DatabaseLogin", shared("db-secret-arn"));
    // Signs the admin pages' forms.
    const appSecret = new secretsmanager.Secret(this, "AppSecret", {
      secretName: "flight-deals/app-secret",
      description: "Signs the flight deals site's admin forms",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    // The price services' API keys. Created empty ("not-set"); the owner
    // pastes each key in here (Secrets Manager → Retrieve secret value →
    // Edit). The site reads them every few minutes, so no redeploy is needed.
    const priceKey = (id: string, secretName: string, description: string) =>
      new secretsmanager.Secret(this, id, {
        secretName,
        description,
        secretStringValue: cdk.SecretValue.unsafePlainText("not-set"),
      });
    const travelpayoutsToken = priceKey("TravelpayoutsToken", "flight-deals/travelpayouts-token", "Travelpayouts API token (paste it in as the whole value)");
    const serpApiKey = priceKey("SerpApiKey", "flight-deals/serpapi-key", "SerpApi API key, for the Google Flights double-check (paste it in as the whole value)");

    // The site's entry in the household sign-in (for Admin).
    const userPool = cognito.UserPool.fromUserPoolId(this, "HouseholdSignIn", shared("user-pool-id"));
    const signInDomain = cognito.UserPoolDomain.fromDomainName(this, "SignInPage", shared("sign-in-domain-prefix"));
    const signInBaseUrl = `https://${signInDomain.domainName}.auth.${this.region}.amazoncognito.com`;
    const signInClient = new cognito.UserPoolClient(this, "SignInClient", {
      userPool,
      userPoolClientName: "flight-deals",
      generateSecret: true, // required by the load balancer
      authFlows: { user: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${siteUrl}/oauth2/idpresponse`],
        logoutUrls: [`${siteUrl}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });
    new cognito.CfnManagedLoginBranding(this, "SignInPageStyle", {
      userPoolId: userPool.userPoolId,
      clientId: signInClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // ── The website (and the scanner, which runs inside it) ─────────────
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: "flight-deals" });
    const logGroup = new logs.LogGroup(this, "WebLogs", {
      logGroupName: "/flight-deals/web",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const emailFrom = `deals@${props.domainName}`;
    const task = new ecs.FargateTaskDefinition(this, "WebTask", {
      family: "flight-deals-web",
      cpu: 256, // 0.25 vCPU
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer("web", {
      containerName: "web",
      // The whole repository is the build (see ../../.dockerignore for what goes in).
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "..", ".."), {
        platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
      }),
      portMappings: [{ containerPort: 8080 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "web", logGroup }),
      environment: {
        PORT: "8080",
        SITE_URL: siteUrl,
        OWNER_EMAIL: props.ownerEmail,
        LOAD_BALANCER_ARN: loadBalancer.loadBalancerArn,
        SIGN_OUT_URL: `${signInBaseUrl}/logout?client_id=${signInClient.userPoolClientId}&logout_uri=${encodeURIComponent(`${siteUrl}/`)}`,
        DB_NAME: "flights",
        // The database on the server that already exists (ticket-hub's),
        // used once to create the flights database.
        DB_ADMIN_DATABASE: "tickethub",
        EMAIL_FROM: `Flight Deals <${emailFrom}>`,
        SITE_TIME_ZONE: props.timeZone,
        TRAVELPAYOUTS_SECRET: travelpayoutsToken.secretArn,
        SERPAPI_SECRET: serpApiKey.secretArn,
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(dbSecret, "host"),
        DB_PORT: ecs.Secret.fromSecretsManager(dbSecret, "port"),
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
        APP_SECRET: ecs.Secret.fromSecretsManager(appSecret),
      },
    });
    travelpayoutsToken.grantRead(task.taskRole);
    serpApiKey.grantRead(task.taskRole);
    // Emails go out only ever from deals@<domain>.
    task.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
        conditions: { StringLike: { "ses:FromAddress": [emailFrom, `*<${emailFrom}>`] } },
      }),
    );

    const firewall = new ec2.SecurityGroup(this, "WebFirewall", {
      vpc,
      description: "Flight deals site: only the load balancer comes in",
      allowAllOutbound: true,
    });
    // The load balancer may reach the website (the way in is added when the
    // service joins the target group below; this is the way out)...
    new ec2.CfnSecurityGroupEgress(this, "LoadBalancerToSite", {
      groupId: albSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      destinationSecurityGroupId: firewall.securityGroupId,
      description: "Load balancer to flight deals site",
    });
    // ...and the website may reach the database server.
    new ec2.CfnSecurityGroupIngress(this, "DatabaseFromSite", {
      groupId: shared("db-security-group-id"),
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: firewall.securityGroupId,
      description: "Flight deals site to PostgreSQL",
    });

    const service = new ecs.FargateService(this, "Web", {
      cluster,
      serviceName: "web",
      taskDefinition: task,
      // Exactly one: the scanner runs inside it.
      desiredCount: 1,
      vpcSubnets: { subnets: vpc.publicSubnets },
      assignPublicIp: true, // no NAT gateway; the firewall still blocks direct access
      securityGroups: [firewall],
      circuitBreaker: { rollback: true }, // a broken release rolls itself back
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "WebTargets", {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service],
      healthCheck: { path: "/health", healthyHttpCodes: "200", interval: cdk.Duration.seconds(30) },
      deregistrationDelay: cdk.Duration.seconds(15),
    });

    // Our rules come before ticket-hub's (priorities 1–9 are kept for other
    // apps; glamping has 1–2, the raffle site 3–4) and only match our address.
    // Admin asks for the household sign-in; everything else is public.
    new elbv2.ApplicationListenerRule(this, "AdminRule", {
      listener,
      priority: 5,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.siteDomain]),
        elbv2.ListenerCondition.pathPatterns(["/admin", "/admin/*", "/oauth2/idpresponse"]),
      ],
      action: new elbv2Actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient: signInClient,
        userPoolDomain: signInDomain,
        scope: "openid email profile",
        sessionTimeout: cdk.Duration.days(7),
        onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });
    new elbv2.ApplicationListenerRule(this, "SiteRule", {
      listener,
      priority: 6,
      conditions: [elbv2.ListenerCondition.hostHeaders([props.siteDomain])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    new cdk.CfnOutput(this, "SiteUrl", { value: siteUrl });
    new cdk.CfnOutput(this, "TravelpayoutsTokenSecret", { value: travelpayoutsToken.secretName });
    new cdk.CfnOutput(this, "SerpApiKeySecret", { value: serpApiKey.secretName });
  }
}
