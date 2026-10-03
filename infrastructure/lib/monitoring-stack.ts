import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { resourcePrefix, type Stage } from "./stage.js";

export interface MonitoringStackProps extends StackProps {
  stage: Stage;
  deadLetterQueue: sqs.IQueue;
  workerLogs: logs.ILogGroup;
  httpApi: apigw.IHttpApi;
  database: rds.IDatabaseInstance;
  /**
   * Correo que recibe las alertas (variable ALERT_EMAIL de GitHub). Sin correo, las alarmas existen
   * pero no avisan a nadie. AWS manda primero un correo para confirmar la suscripción.
   */
  alertEmail?: string;
  /** Presupuesto mensual de AWS en USD (variable MONTHLY_BUDGET_USD). Sin valor, no se crea. */
  monthlyBudgetUsd?: number;
}

/**
 * Avisos por correo cuando algo falla o el gasto sube:
 * - trabajos de video que fallaron una y otra vez (cola de errores);
 * - OpenAI sin saldo o con la clave inválida, y el proxy de descargas sin saldo;
 * - la API respondiendo errores 5xx;
 * - la base de datos con poco espacio o con la CPU al tope;
 * - el gasto de AWS del mes por encima del 80 % (y del 100 %) del presupuesto.
 */
export class MonitoringStack extends Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    const prefix = resourcePrefix(props.stage);

    this.topic = new sns.Topic(this, "Alerts", { topicName: `${prefix}-alerts`, displayName: "ClipFlow alertas" });
    const email = props.alertEmail?.trim();
    if (email) this.topic.addSubscription(new subscriptions.EmailSubscription(email));
    const notify = new actions.SnsAction(this.topic);

    const alarm = (id: string, options: cloudwatch.AlarmProps) => {
      const a = new cloudwatch.Alarm(this, id, {
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...options,
      });
      a.addAlarmAction(notify);
      a.addOkAction(notify);
      return a;
    };

    alarm("JobsFailedAlarm", {
      alarmName: `${prefix}-alert-jobs-failed`,
      alarmDescription: "Hay trabajos de video que fallaron repetidamente (revisar los logs del worker en CloudWatch).",
      metric: props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    // Problemas que no se arreglan solos y cortan la IA o las descargas para todos.
    const logAlarm = (id: string, name: string, pattern: string, description: string) => {
      const filter = new logs.MetricFilter(this, `${id}Filter`, {
        logGroup: props.workerLogs,
        filterPattern: logs.FilterPattern.literal(pattern),
        metricNamespace: "ClipFlow",
        metricName: `${name}-${props.stage}`,
        metricValue: "1",
      });
      alarm(id, {
        alarmName: `${prefix}-alert-${name}`,
        alarmDescription: description,
        metric: filter.metric({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });
    };
    logAlarm(
      "OpenAiAlarm",
      "openai-account",
      '?"insufficient_quota" ?"invalid_api_key"',
      "OpenAI rechazó la clave o la cuenta no tiene saldo: los videos se procesan sin IA. Revisa Billing en platform.openai.com.",
    );
    logAlarm(
      "ProxyAlarm",
      "download-proxy",
      '"sin saldo, 402"',
      "El proxy de descargas (Evomi) no tiene saldo: Instagram y Facebook pueden fallar. Recarga en Evomi.",
    );

    alarm("ApiErrorsAlarm", {
      alarmName: `${prefix}-alert-api-5xx`,
      alarmDescription: "La API está respondiendo errores 5xx (revisar los logs de la API en CloudWatch).",
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "5xx",
        dimensionsMap: { ApiId: props.httpApi.apiId },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    alarm("DatabaseStorageAlarm", {
      alarmName: `${prefix}-alert-db-storage`,
      alarmDescription: "A la base de datos le quedan menos de 2 GB libres.",
      metric: props.database.metric("FreeStorageSpace", { period: Duration.minutes(15), statistic: "Minimum" }),
      threshold: 2 * 1024 ** 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });

    alarm("DatabaseCpuAlarm", {
      alarmName: `${prefix}-alert-db-cpu`,
      alarmDescription: "La CPU de la base de datos lleva 15 minutos por encima del 80 %.",
      metric: props.database.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Presupuesto de toda la cuenta de AWS (no solo este entorno): configurarlo en un solo entorno.
    if (email && props.monthlyBudgetUsd && props.monthlyBudgetUsd > 0) {
      const notification = (threshold: number, notificationType: "ACTUAL" | "FORECASTED") => ({
        notification: { comparisonOperator: "GREATER_THAN", notificationType, threshold, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "EMAIL", address: email }],
      });
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: `${prefix}-monthly`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
        },
        notificationsWithSubscribers: [notification(80, "ACTUAL"), notification(100, "ACTUAL"), notification(100, "FORECASTED")],
      });
    }
  }
}
