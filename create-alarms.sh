#!/bin/bash
set -euo pipefail

PROFILE="idp-dev"
REGION="us-east-1"
SNS_ARN="arn:aws:sns:us-east-1:430695043165:idp-dev-alerts"
AWS="aws --profile $PROFILE --region $REGION"

# --- Step Functions Alarms ---
SM_NAME="idp-dev-document-pipeline"
for metric in ExecutionsFailed ExecutionsTimedOut ExecutionThrottled; do
  echo "Creating Step Functions alarm: $metric"
  $AWS cloudwatch put-metric-alarm \
    --alarm-name "idp-dev-sfn-${metric}" \
    --alarm-description "Step Functions ${metric} > 0 for ${SM_NAME}" \
    --namespace "AWS/States" \
    --metric-name "$metric" \
    --dimensions "Name=StateMachineArn,Value=arn:aws:states:us-east-1:430695043165:stateMachine:${SM_NAME}" \
    --statistic Sum \
    --period 300 \
    --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 \
    --alarm-actions "$SNS_ARN" \
    --treat-missing-data notBreaching
done

# --- Lambda Alarms ---
LAMBDAS="idp-decomposition idp-quality-check idp-classification idp-data-extraction idp-fraud-check idp-mark-complete idp-mark-rejected idp-send-feedback idp-api idp-populate-db"

for fn in $LAMBDAS; do
  echo "Creating Lambda alarms for: $fn"
  $AWS cloudwatch put-metric-alarm \
    --alarm-name "idp-dev-lambda-errors-${fn}" \
    --alarm-description "Lambda Errors > 0 for ${fn}" \
    --namespace "AWS/Lambda" \
    --metric-name Errors \
    --dimensions "Name=FunctionName,Value=${fn}" \
    --statistic Sum --period 300 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 --alarm-actions "$SNS_ARN" \
    --treat-missing-data notBreaching

  $AWS cloudwatch put-metric-alarm \
    --alarm-name "idp-dev-lambda-throttles-${fn}" \
    --alarm-description "Lambda Throttles > 0 for ${fn}" \
    --namespace "AWS/Lambda" \
    --metric-name Throttles \
    --dimensions "Name=FunctionName,Value=${fn}" \
    --statistic Sum --period 300 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 --alarm-actions "$SNS_ARN" \
    --treat-missing-data notBreaching

  $AWS cloudwatch put-metric-alarm \
    --alarm-name "idp-dev-lambda-duration-${fn}" \
    --alarm-description "Lambda Duration > 25s for ${fn}" \
    --namespace "AWS/Lambda" \
    --metric-name Duration \
    --dimensions "Name=FunctionName,Value=${fn}" \
    --statistic Maximum --period 300 --threshold 25000 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 --alarm-actions "$SNS_ARN" \
    --treat-missing-data notBreaching
done

# --- Aurora Alarms ---
CLUSTER_ID="idp-dev"
echo "Creating Aurora alarms"
$AWS cloudwatch put-metric-alarm \
  --alarm-name "idp-dev-aurora-cpu" \
  --alarm-description "Aurora CPU > 80%" \
  --namespace "AWS/RDS" --metric-name CPUUtilization \
  --dimensions "Name=DBClusterIdentifier,Value=${CLUSTER_ID}" \
  --statistic Average --period 300 --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 --alarm-actions "$SNS_ARN" \
  --treat-missing-data notBreaching

$AWS cloudwatch put-metric-alarm \
  --alarm-name "idp-dev-aurora-memory" \
  --alarm-description "Aurora FreeableMemory < 256MB" \
  --namespace "AWS/RDS" --metric-name FreeableMemory \
  --dimensions "Name=DBClusterIdentifier,Value=${CLUSTER_ID}" \
  --statistic Average --period 300 --threshold 268435456 \
  --comparison-operator LessThanThreshold \
  --evaluation-periods 2 --alarm-actions "$SNS_ARN" \
  --treat-missing-data notBreaching

$AWS cloudwatch put-metric-alarm \
  --alarm-name "idp-dev-aurora-connections" \
  --alarm-description "Aurora DatabaseConnections > 80" \
  --namespace "AWS/RDS" --metric-name DatabaseConnections \
  --dimensions "Name=DBClusterIdentifier,Value=${CLUSTER_ID}" \
  --statistic Maximum --period 300 --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 --alarm-actions "$SNS_ARN" \
  --treat-missing-data notBreaching

# --- SQS Alarms ---
for q in idp-dev-fraud-review-queue idp-dev-hitl-queue; do
  echo "Creating SQS alarms for: $q"
  $AWS cloudwatch put-metric-alarm \
    --alarm-name "idp-dev-sqs-depth-${q}" \
    --alarm-description "SQS messages visible > 100 for ${q}" \
    --namespace "AWS/SQS" --metric-name ApproximateNumberOfMessagesVisible \
    --dimensions "Name=QueueName,Value=${q}" \
    --statistic Maximum --period 300 --threshold 100 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 --alarm-actions "$SNS_ARN" \
    --treat-missing-data notBreaching

  $AWS cloudwatch put-metric-alarm \
    --alarm-name "idp-dev-sqs-age-${q}" \
    --alarm-description "SQS oldest message > 1hr for ${q}" \
    --namespace "AWS/SQS" --metric-name ApproximateAgeOfOldestMessage \
    --dimensions "Name=QueueName,Value=${q}" \
    --statistic Maximum --period 300 --threshold 3600 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 --alarm-actions "$SNS_ARN" \
    --treat-missing-data notBreaching
done

# --- API Gateway Alarms ---
API_ID="rzeejg3ra4"
echo "Creating API Gateway alarms"
$AWS cloudwatch put-metric-alarm \
  --alarm-name "idp-dev-apigw-5xx" \
  --alarm-description "API Gateway 5XX errors > 0" \
  --namespace "AWS/ApiGateway" --metric-name 5XXError \
  --dimensions "Name=ApiId,Value=${API_ID}" \
  --statistic Sum --period 300 --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 --alarm-actions "$SNS_ARN" \
  --treat-missing-data notBreaching

$AWS cloudwatch put-metric-alarm \
  --alarm-name "idp-dev-apigw-latency-p99" \
  --alarm-description "API Gateway p99 latency > 5000ms" \
  --namespace "AWS/ApiGateway" --metric-name Latency \
  --dimensions "Name=ApiId,Value=${API_ID}" \
  --extended-statistic p99 --period 300 --threshold 5000 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 --alarm-actions "$SNS_ARN" \
  --treat-missing-data notBreaching

echo "All alarms created successfully!"
