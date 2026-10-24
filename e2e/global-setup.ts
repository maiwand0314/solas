import { e2eDatabaseUrl } from "../playwright.config";
import { prepareTestDatabase } from "../src/test/global-setup";

export default async function globalSetup() {
  await prepareTestDatabase(e2eDatabaseUrl());
}
