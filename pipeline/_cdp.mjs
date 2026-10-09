// A minimal CDP driver, so the city can be looked at from the terminal.
// Node has a global WebSocket now, so this needs no dependencies.
import fs from "node:fs";

const PORT = process.env.CDP_PORT || 9222;
const OUT = process.env.SHOT || "shot.png";
const URL_ = process.env.PAGE || "http://localhost:5177/";
const SETUP = process.env.SETUP || "";
const WAIT = Number(process.env.WAIT || 11000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
    return r.result?.result?.value;
  };
  return { ws, send, evaluate };
}

// Navigate on one connection, then reconnect before evaluating anything.
// Runtime.evaluate on the connection that issued the navigation lands in the
// execution context of the *old* document, where every selector returns null —
// which reads exactly like a page that failed to render.
let c = await connect();
await c.send("Page.enable");
await c.send("Page.navigate", { url: URL_ });
await sleep(WAIT);
c.ws.close();

c = await connect();
await c.evaluate(`document.querySelector('[data-start]').click();
  document.querySelector('[data-veil]').style.display = 'none'; 1`);
await sleep(2500);
if (SETUP) console.log(await c.evaluate(SETUP));
await sleep(Number(process.env.SETTLE || 2500));

if (process.env.AFTER) console.log(await c.evaluate(process.env.AFTER));

const shot = await c.send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
console.log("wrote", OUT);
c.ws.close();
