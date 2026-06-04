import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

// CORS headers required for Claude to connect
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const sessions = new Map();

function buildMcpServer() {
  const server = new McpServer({ name: "usaspending", version: "1.0.0" });

  // --- search_awards ---
  server.tool(
    "search_awards",
    "Search federal contract awards on USASpending.gov by keyword, recipient, agency, NAICS, PSC, or amount range.",
    {
      keyword: z.string().optional().describe("Search term matching award description"),
      recipient: z.string().optional().describe("Recipient/contractor name"),
      agency: z.string().optional().describe("Awarding agency name"),
      naics: z.string().optional().describe("NAICS code"),
      psc: z.string().optional().describe("PSC code"),
      min_amount: z.number().optional().describe("Minimum award amount in dollars"),
      max_amount: z.number().optional().describe("Maximum award amount in dollars"),
      limit: z.number().optional().default(10).describe("Number of results (max 25)"),
      page: z.number().optional().default(1).describe("Page number"),
    },
    async ({ keyword, recipient, agency, naics, psc, min_amount, max_amount, limit, page }) => {
      const filters = { award_type_codes: ["A", "B", "C", "D"] };
      const keywords = [];
      if (keyword) keywords.push(keyword);
      if (agency) keywords.push(agency);
      if (recipient) filters.recipient_search_text = [recipient];
      if (naics) filters.naics_codes = { require: [naics] };
      if (psc) filters.psc_codes = { require: [psc] };
      if (min_amount || max_amount) {
        const range = {};
        if (min_amount) range.lower_bound = min_amount;
        if (max_amount) range.upper_bound = max_amount;
        filters.award_amounts = [range];
      }
      const body = {
        filters,
        fields: ["Award ID", "Recipient Name", "Description", "Awarding Agency",
                 "Award Amount", "Start Date", "End Date", "Contract Award Type"],
        sort: "Award Amount",
        order: "desc",
        limit: Math.min(limit ?? 10, 25),
        page: page ?? 1,
        subawards: false,
      };
      if (keywords.length) body.keywords = keywords;

      const resp = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`USASpending API error: ${resp.status}`);
      const data = await resp.json();
      return {
        content: [{ type: "text", text: JSON.stringify({ total: data.page_metadata?.total, results: data.results || [] }, null, 2) }],
      };
    }
  );

  // --- get_award ---
  server.tool(
    "get_award",
    "Get full details for a specific federal contract by its award ID / PIID (e.g. W25G1V22F0157).",
    { award_id: z.string().describe("The contract award ID or PIID") },
    async ({ award_id }) => {
      const resp = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: { award_type_codes: ["A", "B", "C", "D"], award_ids: [award_id] },
          fields: ["Award ID", "Recipient Name", "Description", "Awarding Agency",
                   "Funding Agency", "Award Amount", "Start Date", "End Date",
                   "Contract Award Type", "generated_internal_id"],
          limit: 1, page: 1, subawards: false,
        }),
      });
      if (!resp.ok) throw new Error(`USASpending API error: ${resp.status}`);
      const data = await resp.json();
      if (!data.results?.length) {
        return { content: [{ type: "text", text: `No award found for ID: ${award_id}` }] };
      }
      const r = data.results[0];
      return {
        content: [{ type: "text", text: JSON.stringify({
          award_id: r["Award ID"],
          recipient: r["Recipient Name"],
          description: r["Description"],
          awarding_agency: r["Awarding Agency"],
          funding_agency: r["Funding Agency"],
          amount: r["Award Amount"],
          start_date: r["Start Date"],
          end_date: r["End Date"],
          type: r["Contract Award Type"],
        }, null, 2) }],
      };
    }
  );

  // --- get_recipient_awards ---
  server.tool(
    "get_recipient_awards",
    "Get all federal contract awards for a specific company or recipient.",
    {
      recipient_name: z.string().describe("Company or recipient name"),
      limit: z.number().optional().default(10).describe("Number of results (max 25)"),
      page: z.number().optional().default(1).describe("Page number"),
    },
    async ({ recipient_name, limit, page }) => {
      const resp = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: { award_type_codes: ["A", "B", "C", "D"], recipient_search_text: [recipient_name] },
          fields: ["Award ID", "Recipient Name", "Description", "Awarding Agency",
                   "Award Amount", "Start Date", "End Date", "Contract Award Type"],
          sort: "Award Amount", order: "desc",
          limit: Math.min(limit ?? 10, 25), page: page ?? 1, subawards: false,
        }),
      });
      if (!resp.ok) throw new Error(`USASpending API error: ${resp.status}`);
      const data = await resp.json();
      return {
        content: [{ type: "text", text: JSON.stringify({ recipient: recipient_name, total: data.page_metadata?.total, results: data.results || [] }, null, 2) }],
      };
    }
  );

  // --- get_agency_spending ---
  server.tool(
    "get_agency_spending",
    "Get contract spending totals by awarding agency for a given keyword or NAICS code.",
    {
      keyword: z.string().optional().describe("Keyword to filter awards"),
      naics: z.string().optional().describe("NAICS code"),
      fiscal_year: z.number().optional().describe("Fiscal year e.g. 2024"),
    },
    async ({ keyword, naics, fiscal_year }) => {
      const filters = { award_type_codes: ["A", "B", "C", "D"] };
      if (keyword) filters.keywords = [keyword];
      if (naics) filters.naics_codes = { require: [naics] };
      if (fiscal_year) filters.time_period = [{ start_date: `${fiscal_year - 1}-10-01`, end_date: `${fiscal_year}-09-30` }];
      const resp = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters,
          fields: ["Award ID", "Awarding Agency", "Award Amount"],
          sort: "Award Amount", order: "desc", limit: 25, page: 1, subawards: false,
        }),
      });
      if (!resp.ok) throw new Error(`USASpending API error: ${resp.status}`);
      const data = await resp.json();
      const byAgency = {};
      for (const r of data.results || []) {
        const ag = r["Awarding Agency"] || "Unknown";
        if (!byAgency[ag]) byAgency[ag] = { count: 0, total: 0 };
        byAgency[ag].count++;
        byAgency[ag].total += parseFloat(r["Award Amount"]) || 0;
      }
      const sorted = Object.entries(byAgency)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([agency, s]) => ({ agency, count: s.count, total_obligated: s.total }));
      return {
        content: [{ type: "text", text: JSON.stringify({ total_awards: data.page_metadata?.total, by_agency: sorted }, null, 2) }],
      };
    }
  );

  return server;
}

// Streamable HTTP transport endpoint
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => sessions.set(id, transport),
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const server = buildMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  const transport = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", service: "usaspending-mcp" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`USASpending MCP server running on port ${PORT}`));