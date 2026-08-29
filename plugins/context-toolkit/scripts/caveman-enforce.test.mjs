import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./caveman-enforce.mjs", import.meta.url));
const TRANSCRIPT = join(tmpdir(), "caveman-cases.jsonl");

// Clear the objection budgets so each case is judged fresh.
try {
  rmSync(join(tmpdir(), "context-toolkit-caveman"), {
    recursive: true,
    force: true,
  });
} catch {}

const cases = [
  {
    name: "drifted reply (real, from this session) — written-out prose, no filler word",
    expect: 2,
    text: `未確定。私の提案であって、あなたの承認はまだ取っていない。

確定していることとして、Intelligence キー4つが無いと server/src/index.ts は起動しないという事実があり、これは config.ts の 533 行から 561 行が例外を投げるためです。また Bot の組み立てを行う resolveRuntimeAgents は Intelligence を参照していないため、agent.runAgent() を直接叩けば Bot は動作します。ツール実行やポリシー、監査、live-view についても同様に Intelligence には依存していません。

未確定なのは、あなたが案A を選ぶか案C を選ぶかという点と、CopilotRuntime が intelligence 無しモードを持つかという点の二つです。後者は scope を変えるため、先に確認するのが妥当だと考えています。`,
  },
  {
    name: "compliant caveman ultra reply",
    expect: 0,
    text: `未確定。私の提案、承認まだ。

確定:
- キー4つ無いと起動しない。config.ts:533-561 が例外
- resolveRuntimeAgents は Intelligence 非参照
- ツール実行・監査・live-view も非依存

未確定:
1. 案A か案C か
2. CopilotRuntime が intelligence 無しモードを持つか

2 は scope を変える。bun install で決着、10分。`,
  },
  {
    name: "quoting the forbidden words to name them (was a false positive)",
    expect: 0,
    text: `検出は語彙マッチ。

リストは「certainly」「もちろん」等の filler 語と "→" 等の装飾記号のみ。

前の回答には0件。閾値2件に届かず通過。`,
  },
  {
    name: "actually using the forbidden words",
    expect: 2,
    text: `Certainly! Basically the answer is A.

Of course, this is worth noting.`,
  },
  {
    name: "table and code heavy reply, little prose",
    expect: 0,
    text: `結果。

| route | bytes |
|---|---|
| full | 33012 |
| search | 1789 |

\`\`\`
code-review-graph build
\`\`\`

95% 削減。`,
  },
  {
    name: "drifted English prose, no forbidden word",
    expect: 2,
    text: `The situation is not yet decided, and this remains a proposal rather than something you have approved.

The confirmed part is that the server will not start without the four Intelligence keys, because the configuration module throws an exception when any of them is absent. The agent construction path does not reference Intelligence at all, which means calling the agent directly is sufficient to run a Bot. Tool execution, policy evaluation and auditing are likewise independent of that layer. What remains open is which of the two options you prefer, and whether the upstream runtime supports a mode without Intelligence.`,
  },
  {
    name: "filenames with dots must not fragment a sentence into fake fragments",
    expect: 2,
    text: `確定していることとして、Intelligence キー4つが無いと server/src/index.ts は起動しないという事実があり、これは config.ts の 533 行から 561 行が例外を投げるためです。また Bot の組み立てを行う resolveRuntimeAgents は Intelligence を参照していないため、agent.runAgent() を直接叩けば Bot は動作します。ツール実行やポリシー、監査、live-view についても同様に Intelligence には依存していません。未確定なのは案の選択と型の確認という二点であり、後者は scope を変えるため先に確認するのが妥当だと考えています。`,
  },
  {
    // The quote exemption must not become a hiding place: wrapping a drifted answer in quotation
    // marks has to measure exactly the same as writing it plainly.
    name: "drift wrapped in quotation marks is still drift (exemption is length-bounded)",
    expect: 2,
    text: `引用。

"確定していることとして、Intelligence キー4つが無いと server/src/index.ts は起動しないという事実があり、これは config.ts の 533 行から 561 行が例外を投げるためです。また Bot の組み立てを行う resolveRuntimeAgents は Intelligence を参照していないため、agent.runAgent() を直接叩けば Bot は動作します。ツール実行やポリシー、監査、live-view についても同様に Intelligence には依存していません。未確定なのは案の選択と型の確認という二点であり、後者は scope を変えるため先に確認するのが妥当だと考えています。"`,
  },
  {
    // The other half of the same property: a short quote naming a forbidden word stays exempt.
    name: "short quote naming a forbidden word stays exempt",
    expect: 0,
    text: `リストは「certainly」と「もちろん」を見る。

前の回答には0件。`,
  },
];

let failures = 0;
for (const testCase of cases) {
  writeFileSync(
    TRANSCRIPT,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: testCase.text }] },
    })}\n`,
  );

  let code = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({
        transcript_path: TRANSCRIPT,
        session_id: testCase.name,
      }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    code = error.status ?? -1;
    stderr = error.stderr ?? "";
  }

  const ok = code === testCase.expect;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  expect=${testCase.expect} got=${code}  ${testCase.name}`,
  );
  if (stderr.trim()) {
    console.log(`        ${stderr.trim().split(" — ")[1]?.slice(0, 110) ?? ""}`);
  }
}

console.log(failures === 0 ? "\nall cases pass" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
