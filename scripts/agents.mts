// Developer tool for checking the agent backend from a terminal while there is
// no Agent Builder UI yet. It is not how agents are meant to be managed: the
// app's UI is (M2B). It talks to the database directly through the same agent
// service the web app uses, so it needs DATABASE_URL and runs only on your machine.
//
//   npm run agents -- list
//   npm run agents -- create --name "Researcher" --role "Finds sources" --instructions "Cite everything."
//   npm run agents -- get <id>
//   npm run agents -- update <id> --description "New description"
//   npm run agents -- disable <id>   |   enable <id>
//   npm run agents -- duplicate <id>
//   npm run agents -- delete <id>
//   npm run agents -- providers
//
// The .mts extension makes this an ES module, so top-level await works.

import { parseArgs } from "node:util";
import { AgentServiceError } from "@/server/agents/errors";
import { createAgentService, type Agent } from "@/server/agents/service";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { getAgentReadiness, providerRegistry } from "@/server/providers/registry";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    description: { type: "string" },
    role: { type: "string" },
    instructions: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
  },
});
const [command, id] = positionals;

function fieldsFromFlags() {
  return Object.fromEntries(
    Object.entries({
      name: values.name,
      description: values.description,
      role: values.role,
      instructions: values.instructions,
      providerId: values.provider,
      modelId: values.model,
    }).filter(([, value]) => value !== undefined),
  );
}

function show(agent: Agent) {
  const readiness = getAgentReadiness(agent, providerRegistry);
  console.log(
    JSON.stringify(
      { ...agent, readiness: readiness.state === "unconfigured" ? `unconfigured: ${readiness.reason}` : readiness.state },
      null,
      2,
    ),
  );
}

const db = createDatabase(process.env.DATABASE_URL ?? "");
const agents = createAgentService({ db, providers: providerRegistry });

try {
  switch (command) {
    case "list": {
      const all = await agents.list();
      if (all.length === 0) console.log("No agents yet.");
      for (const agent of all) {
        console.log(`${agent.id}  ${agent.enabled ? "enabled " : "disabled"}  ${agent.name}${agent.role ? ` — ${agent.role}` : ""}`);
      }
      break;
    }
    case "create":
      show(await agents.create(fieldsFromFlags()));
      break;
    case "get":
      show(await agents.get(id));
      break;
    case "update":
      show(await agents.update(id, fieldsFromFlags()));
      break;
    case "enable":
    case "disable":
      show(await agents.setEnabled(id, command === "enable"));
      break;
    case "duplicate":
      show(await agents.duplicate(id));
      break;
    case "delete":
      await agents.remove(id);
      console.log(`Deleted ${id}.`);
      break;
    case "providers":
      for (const provider of providerRegistry.list()) {
        console.log(`${provider.id}  ${provider.status}${provider.statusReason ? ` — ${provider.statusReason}` : ""}`);
      }
      break;
    default:
      console.log("Commands: list, create, get <id>, update <id>, enable <id>, disable <id>, duplicate <id>, delete <id>, providers");
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  if (error instanceof AgentServiceError) {
    console.error(`Error (${error.code}): ${error.message}`);
    for (const [field, messages] of Object.entries(error.fieldErrors)) {
      console.error(`  ${field}: ${messages?.join(" ")}`);
    }
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closeDatabase(db);
}
