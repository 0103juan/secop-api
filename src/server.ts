import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { Directory } from "./entities.ts";

const port = Number(process.env.PORT ?? 3000);
const directory = Directory.fromFile(new URL("../data/entities.json", import.meta.url));
const app = createApp({
  directory,
  allowedOrigin: process.env.ALLOWED_ORIGIN,
  appToken: process.env.SOCRATA_APP_TOKEN,
});

createServer(app).listen(port, () => {
  console.log(`secop-api listening on http://localhost:${port} with ${directory.size} entities`);
});
