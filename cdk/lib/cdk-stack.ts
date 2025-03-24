import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface PreprodPolisStackProps extends cdk.StackProps {
  enableSSHAccess?: boolean;
  envFile: string;
  branch?: string;
  sshAllowedIpRange?: string;
  webKeyPairName?: string;
  mathWorkerKeyPairName?: string;
}

export class PreprodPolisStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PreprodPolisStackProps) {
    super(scope, id, props);

    const defaultSSHRange = '0.0.0.0/0';

    const vpc = new ec2.Vpc(this, 'PreprodVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PreprodPublic',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PreprodPrivate',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ]
    });

    const alarmTopic = new sns.Topic(this, 'PreprodAlarmTopic', {
      displayName: 'Preprod Polis Application Alarms',
    });

    alarmTopic.addSubscription(new subscriptions.EmailSubscription('tim@compdemocracy.org'));

    const logGroup = new logs.LogGroup(this, 'PreprodLogGroup');

    const instanceTypeWeb = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);
    const machineImageWeb = new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023 });
    const instanceTypeMathWorker = ec2.InstanceType.of(ec2.InstanceClass.R8G, ec2.InstanceSize.XLARGE);
    const machineImageMathWorker = new ec2.AmazonLinuxImage({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });

    const webSecurityGroup = new ec2.SecurityGroup(this, 'PreprodWebSecurityGroup', {
      vpc,
      description: 'Allow HTTP and SSH access to preprod web instances',
      allowAllOutbound: true,
    });

    const mathWorkerSecurityGroup = new ec2.SecurityGroup(this, 'PreprodMathWorkerSG', {
      vpc,
      description: 'Security group for preprod Polis math worker',
      allowAllOutbound: true,
    });

    if (props.enableSSHAccess) {
      webSecurityGroup.addIngressRule(ec2.Peer.ipv4(props.sshAllowedIpRange || defaultSSHRange), ec2.Port.tcp(22), 'Allow SSH access');
      mathWorkerSecurityGroup.addIngressRule(ec2.Peer.ipv4(props.sshAllowedIpRange || defaultSSHRange), ec2.Port.tcp(22), 'Allow SSH access');
    }

    let webKeyPair: ec2.IKeyPair | undefined;
    if (props.enableSSHAccess) {
      webKeyPair = props.webKeyPairName
      ? ec2.KeyPair.fromKeyPairName(this, 'PreprodWebKeyPair', props.webKeyPairName)
      : new ec2.KeyPair(this, 'PreprodWebKeyPair');
    }

    let mathWorkerKeyPair: ec2.IKeyPair | undefined;
      if (props.enableSSHAccess) {
        mathWorkerKeyPair = props.mathWorkerKeyPairName
        ? ec2.KeyPair.fromKeyPairName(this, 'PreprodMathWorkerKeyPair', props.mathWorkerKeyPairName)
        : new ec2.KeyPair(this, 'PreprodMathWorkerKeyPair');
      }

    const instanceRole = new iam.Role(this, 'PreprodInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforAWSCodeDeploy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess')
      ],
    });

    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:PutObjectAcl', 's3:AbortMultipartUpload'],
      resources: ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'],
    }));

    const codeDeployRole = new iam.Role(this, 'PreprodCodeDeployRole', {
      assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSCodeDeployRole'),
      ],
    });

    const lbSecurityGroup = new ec2.SecurityGroup(this, 'PreprodLBSecurityGroup', {
      vpc,
      description: 'Security group for the load balancer',
      allowAllOutbound: true,
    });
    lbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');
    lbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from anywhere');

    webSecurityGroup.addIngressRule(ec2.Peer.ipv4(props.sshAllowedIpRange || defaultSSHRange), ec2.Port.tcp(22), 'Allow SSH');
    webSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');
    webSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from anywhere');

    const dbSubnetGroup = new rds.SubnetGroup(this, 'PreprodDatabaseSubnetGroup', {
      vpc,
      subnetGroupName: 'PreprodPolisDatabaseSubnetGroup',
      description: 'Subnet group for the preprod postgres database',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const db = new rds.DatabaseInstance(this, 'PreprodDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
      vpc,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP2,
      credentials: rds.Credentials.fromGeneratedSecret('dbUser'),
      databaseName: 'polisdb',
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      deletionProtection: true,
      publiclyAccessible: false,
      subnetGroup: dbSubnetGroup,
    });

    const dbSecretArnParam = new ssm.StringParameter(this, 'PreprodDBSecretArnParameter', {
      parameterName: '/preprod/polis/db-secret-arn',
      stringValue: db.secret!.secretArn,
      description: 'SSM Parameter storing the ARN of the Preprod Polis Database Secret',
    });

    const dbHostParam = new ssm.StringParameter(this, 'PreprodDBHostParameter', {
      parameterName: '/preprod/polis/db-host',
      stringValue: db.dbInstanceEndpointAddress,
      description: 'SSM Parameter storing the Preprod Polis Database Host',
    });

    const dbPortParam = new ssm.StringParameter(this, 'PreprodDBPortParameter', {
      parameterName: '/preprod/polis/db-port',
      stringValue: db.dbInstanceEndpointPort,
      description: 'SSM Parameter storing the Preprod Polis Database Port',
    });

    const usrdata = (CLOUDWATCH_LOG_GROUP_NAME: string, service: string) => {
      let ld;
      ld = ec2.UserData.forLinux();
      ld.addCommands(
        '#!/bin/bash',
        'set -e',
        'set -x',
        `echo "Writing service type '${service}' to /tmp/service_type.txt"`,
        `echo "${service}" > /tmp/service_type.txt`,
        `echo "Contents of /tmp/service_type.txt: $(cat /tmp/service_type.txt)"`,
        'sudo yum update -y',
        'sudo yum install -y amazon-cloudwatch-agent -y',
        'sudo dnf install -y wget ruby docker',
        'sudo systemctl start docker',
        'sudo systemctl enable docker',
        'sudo usermod -a -G docker ec2-user',
        'sudo curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m) -o /usr/local/bin/docker-compose',
        'sudo chmod +x /usr/local/bin/docker-compose',
        'docker-compose --version',
        'sudo yum install -y jq',
        `export SERVICE=${service}`,
        'exec 1>>/var/log/user-data.log 2>&1',
        'echo "Finished User Data Execution at $(date)"',
        'sudo mkdir -p /etc/docker',
        `sudo tee /etc/docker/daemon.json << EOF
{
  "log-driver": "awslogs",
  "log-opts": {
    "awslogs-group": "${CLOUDWATCH_LOG_GROUP_NAME}",
    "awslogs-region": "${cdk.Stack.of(this).region}",
    "awslogs-stream": "${service}"
  }
}
EOF`,
        'sudo systemctl restart docker',
        'sudo systemctl status docker'
      );
      return ld;
    };

    const webLaunchTemplate = new ec2.LaunchTemplate(this, 'PreprodWebLaunchTemplate', {
      machineImage: machineImageWeb,
      userData: usrdata(logGroup.logGroupName, "server"),
      instanceType: instanceTypeWeb,
      securityGroup: webSecurityGroup,
      keyPair: props.enableSSHAccess ? webKeyPair : undefined,
      role: instanceRole,
    });

    const mathWorkerLaunchTemplate = new ec2.LaunchTemplate(this, 'PreprodMathWorkerLaunchTemplate', {
      machineImage: machineImageMathWorker,
      userData: usrdata(logGroup.logGroupName, "math"),
      instanceType: instanceTypeMathWorker,
      securityGroup: mathWorkerSecurityGroup,
      keyPair: props.enableSSHAccess ? mathWorkerKeyPair : undefined,
      role: instanceRole,
    });

    const webInstance = new ec2.Instance(this, 'PreprodWebInstance', {
      vpc,
      instanceType: instanceTypeWeb,
      machineImage: machineImageWeb,
      securityGroup: webSecurityGroup,
      keyPair: props.enableSSHAccess ? webKeyPair : undefined,
      role: instanceRole,
      userData: webLaunchTemplate.userData,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const mathInstance = new ec2.Instance(this, 'PreprodMathWorkerInstance', {
      vpc,
      instanceType: instanceTypeMathWorker,
      machineImage: machineImageMathWorker,
      securityGroup: mathWorkerSecurityGroup,
      keyPair: props.enableSSHAccess ? mathWorkerKeyPair : undefined,
      role: instanceRole,
      userData: mathWorkerLaunchTemplate.userData,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const application = new codedeploy.ServerApplication(this, 'PreprodCodeDeployApplication', {
      applicationName: 'PreprodPolisApplication',
    });

    const deploymentBucket = new s3.Bucket(this, 'PreprodDeploymentPackageBucket', {
      bucketName: `preprod-polis-deployment-packages-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    deploymentBucket.grantRead(instanceRole);

    const asgWeb = new autoscaling.AutoScalingGroup(this, 'PreprodAsg', {
      vpc,
      launchTemplate: webLaunchTemplate,
      minCapacity: 1,
      maxCapacity: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      healthCheck: autoscaling.HealthCheck.elb({grace: cdk.Duration.minutes(15)})
    });
    const asgMathWorker = new autoscaling.AutoScalingGroup(this, 'AsgMathWorker', {
      vpc,
      launchTemplate: mathWorkerLaunchTemplate,
      minCapacity: 1,
      maxCapacity: 2,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(15) }),
    });
    const deploymentGroup = new codedeploy.ServerDeploymentGroup(this, 'PreprodDeploymentGroup', {
      application,
      deploymentGroupName: 'PreprodPolisDeploymentGroup',
      autoScalingGroups: [asgWeb, asgMathWorker],
      deploymentConfig: codedeploy.ServerDeploymentConfig.ONE_AT_A_TIME,
      role: codeDeployRole,
      installAgent: true,
      autoRollback: {
        failedDeployment: true,
        stoppedDeployment: true,
        deploymentInAlarm: true,
      },
    });

    db.connections.allowFrom(webInstance, ec2.Port.tcp(5432), 'Allow database access from web instance');
    db.connections.allowFrom(mathInstance, ec2.Port.tcp(5432), 'Allow database access from math instance');

    const lb = new elbv2.ApplicationLoadBalancer(this, 'PreprodLb', {
      vpc,
      internetFacing: true,
      securityGroup: lbSecurityGroup,
      idleTimeout: cdk.Duration.seconds(300),
    });


    const webTargetGroup = new elbv2.ApplicationTargetGroup(this, 'PreprodWebAppTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asgWeb],
      healthCheck: {
        path: "/api/v3/testConnection",
        interval: cdk.Duration.seconds(300),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
        timeout: cdk.Duration.seconds(10),
      }
    });

    const httpListener = lb.addListener('PreprodHttpListener', {
      port: 80,
      open: true,
      defaultTargetGroups: [webTargetGroup],
    });

    const certificate = new acm.Certificate(this, 'PreprodWebAppCertificate', {
      domainName: 'preprod.pol.is',
      validation: acm.CertificateValidation.fromDns(),
    });

    const httpsListener = lb.addListener('PreprodHttpsListener', {
      port: 443,
      certificates: [certificate],
      open: true,
      defaultTargetGroups: [webTargetGroup],
    });

    const webAppEnvVarsSecret = new secretsmanager.Secret(this, 'PreprodWebAppEnvVarsSecret', {
      secretName: 'preprod-polis-web-app-env-vars',
      description: 'Environment variables for the Preprod Polis web application',
    });

    webInstance.node.addDependency(logGroup);
    webInstance.node.addDependency(webAppEnvVarsSecret);
    mathInstance.node.addDependency(logGroup);
    mathInstance.node.addDependency(webAppEnvVarsSecret);
    webInstance.node.addDependency(db);
    mathInstance.node.addDependency(db);
  }
}