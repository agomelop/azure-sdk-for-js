// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from "fs";
import childProcess from "child_process";
import { CertificatesClient } from "../src";
import { retry, isRecording } from "./utils/recorder";
import { isNode } from "@azure/core-http";
import { env } from "@azure/test-utils-recorder";
import { authenticate } from "./utils/testAuthentication";
import TestClient from "./utils/testClient";
import { SecretsClient } from "@azure/keyvault-secrets";
import { ClientSecretCredential } from "@azure/identity";

describe("Certificates client - merge and import certificates", () => {
  const prefix = `merge${env.CERTIFICATE_NAME || "CertificateName"}`;
  let suffix: string;
  let client: CertificatesClient;
  let testClient: TestClient;
  let recorder: any;
  let keyVaultUrl: string;
  let credential: ClientSecretCredential;
  let secretsClient: SecretsClient;

  beforeEach(async function() {
    const authentication = await authenticate(this);
    suffix = authentication.suffix;
    client = authentication.client;
    testClient = authentication.testClient;
    recorder = authentication.recorder;
    keyVaultUrl = authentication.keyVaultUrl;
    credential = authentication.credential;
    secretsClient = new SecretsClient(keyVaultUrl, credential);
  });

  afterEach(async function() {
    recorder.stop();
  });

  // The tests follow

  it("can import a certificate from a backup", async function() {
    const certificateName = testClient.formatName(`${prefix}-${this!.test!.title}-${suffix}`);
    const certificateNames = [`${certificateName}0`, `${certificateName}1`];
    await client.createCertificate(certificateNames[0], {
      certificatePolicy: {
        issuerParameters: { name: "Self" },
        x509CertificateProperties: { subject: "cn=MyCert" }
      }
    });
    const certificateSecret = await retry(async () => secretsClient.getSecret(certificateNames[0]));
    const base64EncodedCertificate = certificateSecret.value!;
    await client.importCertificate(certificateNames[1], base64EncodedCertificate);

    for (const name of certificateNames) {
      await testClient.flushCertificate(name);
    } 
  });

  // The signed csr will never be the same.
  if (isNode && isRecording) {
    it("can merge a self signed certificate", async function() {
      const certificateName = testClient.formatName(`${prefix}-${this!.test!.title}-${suffix}`);

      await client.createCertificate(certificateName, {
        certificatePolicy: {
          issuerParameters: {
            name: "Unknown",
            certificateTransparency: false
          },
          x509CertificateProperties: { subject: "cn=MyCert" } 
        }
      });

      const { csr } = await client.getCertificateOperation(certificateName);
      const base64Csr = Buffer.from(csr!).toString("base64");
      const wrappedCsr = `-----BEGIN CERTIFICATE REQUEST-----
${base64Csr}
-----END CERTIFICATE REQUEST-----`;
      fs.writeFileSync("test.csr", wrappedCsr);

      // Certificate available locally made using:
      //   openssl genrsa -out ca.key 2048
      //   openssl req -new -x509 -key ca.key -out ca.crt
      childProcess.execSync("openssl x509 -req -in test.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out test.crt");
      const base64Crt = fs.readFileSync("test.crt").toString().split("\n").slice(1, -1).join("");

      await client.mergeCertificate(certificateName, [Buffer.from(base64Crt)]);
  
      await testClient.flushCertificate(certificateName);
    });
  }
}); 
