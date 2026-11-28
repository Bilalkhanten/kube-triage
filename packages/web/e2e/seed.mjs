// Inserts one known incident into the e2e database. The API has already applied migrations.
import { createDb, incidents, migrate } from "../../api/dist/index.js";
import { INCIDENT_ID, INCIDENT_TITLE, TIMELINE } from "./fixture.mjs";

export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const handle = createDb(url);
  try {
    await migrate(handle.pool);
    await handle.db.delete(incidents);
    await handle.db.insert(incidents).values({
      id: INCIDENT_ID,
      createdBy: "e2e-seed",
      namespace: "shop",
      service: "checkout",
      windowFrom: new Date(TIMELINE.scope.from),
      windowTo: new Date(TIMELINE.scope.to),
      severity: "critical",
      title: INCIDENT_TITLE,
      timeline: TIMELINE,
    });
  } finally {
    await handle.close();
  }
}
