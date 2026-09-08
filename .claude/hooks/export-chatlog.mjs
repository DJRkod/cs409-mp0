#!/usr/bin/env node
/*
 * Regenerates llm_logs.csv from every Claude Code transcript recorded for this
 * project, so the file always holds the full chatlog the CS 409 LLM-usage
 * policy requires. Wired up as a Stop hook in .claude/settings.json, which
 * makes it run after every exchange.
 *
 * Rebuilding from scratch (rather than appending) keeps the file correct across
 * resumed sessions, compaction, and multiple work sessions on different days.
 *
 * Captures: user prompts (including answers to Claude's questions), Claude's
 * visible replies, and the tool calls Claude made. Skips internal reasoning,
 * tool output, and harness-injected content such as system reminders and the
 * skill definitions that arrive under a user role.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(fileURLToPath(import.meta.url), '../../../llm_logs.csv');

const stripReminders = (s) =>
  s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

function summarizeTool(block) {
  const name = block.name ?? 'tool';
  const input = block.input ?? {};
  let detail;
  if (typeof input.command === 'string') detail = input.command;
  else if (typeof input.file_path === 'string') detail = input.file_path;
  else if (typeof input.skill === 'string') detail = input.skill;
  else if (typeof input.pattern === 'string') detail = input.pattern;
  else detail = JSON.stringify(input);
  if (detail.length > 2000) detail = detail.slice(0, 2000) + ' ...[truncated]';
  return `${name}: ${detail}`;
}

// The hook receives its payload as JSON on stdin; transcript_path tells us which
// directory holds this project's transcripts.
let transcriptDir;
try {
  transcriptDir = dirname(JSON.parse(readFileSync(0, 'utf8')).transcript_path);
} catch {
  process.exit(0); // Nothing to do without a transcript; never block the turn.
}

const rows = [];
// tool_use id -> tool name, so a tool_result can be traced back to its call.
const toolNames = new Map();

for (const file of readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'))) {
  let lines;
  try {
    lines = readFileSync(join(transcriptDir, file), 'utf8').split('\n');
  } catch {
    continue;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (!msg || !rec.timestamp) continue;
    if (rec.isSidechain) continue; // subagent chatter, not the conversation
    // isMeta marks anything the harness injected under a user role: system
    // reminders, and the skill definitions loaded mid-turn.
    if (rec.isMeta) continue;
    const base = { ts: rec.timestamp, sid: rec.sessionId ?? '' };

    if (rec.type === 'user' && typeof msg.content === 'string') {
      const text = stripReminders(msg.content);
      if (text) rows.push({ ...base, role: 'user', content: text });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === 'text' && block.text?.trim()) {
        const text = rec.type === 'user' ? stripReminders(block.text) : block.text;
        if (text) rows.push({ ...base, role: rec.type, content: text });
      } else if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name);
        rows.push({ ...base, role: 'tool_use', content: summarizeTool(block) });
      } else if (block.type === 'tool_result') {
        // Tool output is excluded, but answers the user gave to Claude's
        // questions arrive this way and are part of the conversation.
        if (toolNames.get(block.tool_use_id) !== 'AskUserQuestion') continue;
        const text = Array.isArray(block.content)
          ? block.content.map((b) => b.text ?? '').join('\n')
          : String(block.content ?? '');
        if (text.trim()) rows.push({ ...base, role: 'user', content: text.trim() });
      }
    }
  }
}

rows.sort((a, b) => a.ts.localeCompare(b.ts));

// Number the exchanges within each session, so a row can be traced back to the
// prompt that produced it.
const turns = new Map();
for (const row of rows) {
  if (row.role === 'user') turns.set(row.sid, (turns.get(row.sid) ?? 0) + 1);
  row.turn = turns.get(row.sid) ?? 1;
}

const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
const csv = [
  'timestamp,session_id,turn,role,content',
  ...rows.map((r) => [r.ts, r.sid, r.turn, r.role, r.content].map(esc).join(',')),
].join('\n');

writeFileSync(OUT, csv + '\n', 'utf8');
