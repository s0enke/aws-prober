#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { CliCredentialsStackSynthesizer } from "aws-cdk-lib";
import { ProberStack } from "../lib/prober-stack";
import * as process from "process";

const app = new cdk.App();
new ProberStack(app, "ProberStack", {
  synthesizer: new CliCredentialsStackSynthesizer({
    fileAssetsBucketName: process.env.FILE_ASSETS_BUCKET_NAME ?? undefined,
    bucketPrefix: process.env.FILE_ASSETS_BUCKET_PREFIX ?? undefined,
  }),
  description:
    "aws-prober - check your AWS account for foundational best practices - https://github.com/s0enke/aws-prober",
});
