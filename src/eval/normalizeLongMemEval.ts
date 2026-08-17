import fs from "fs";
import path from "path";

type RawInstance = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  answer_session_ids?: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: { role: string; content: string }[][];
};

function toIsoTimestamp(value: string): string {
  const parsed = new Date(value.replace(/\s*\([^)]*\)/, ""));
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function main() {
  const input = process.argv[2] ?? path.join("data", "official", "longmemeval", "longmemeval_s_cleaned.json");
  const output = process.argv[3] ?? path.join("data", "official", "longmemeval", "longmemeval_s_normalized.json");
  const raw = JSON.parse(fs.readFileSync(input, "utf8")) as RawInstance[];

  const normalized = raw.map((item) => ({
    question_id: item.question_id,
    question: item.question,
    answer: item.answer ?? "",
    question_type: item.question_type,
    answer_session_ids: item.answer_session_ids ?? [],
    sessions: item.haystack_sessions.map((turns, index) => ({
      session_id: item.haystack_session_ids[index] ?? `${item.question_id}-session-${index + 1}`,
      timestamp: toIsoTimestamp(item.haystack_dates[index] ?? ""),
      turns,
    })),
  }));

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(normalized));
  const sessionCount = normalized.reduce((sum, item) => sum + item.sessions.length, 0);
  console.log(`Normalized ${normalized.length} questions and ${sessionCount} sessions.`);
  console.log(`Wrote ${output}`);
}

main();
