#!/usr/bin/env node
/**
 * SessionStart hook: put the caveman-ultra enforcement back if either half of it has gone missing.
 *
 * The enforcement lives in two places on purpose — this plugin's own hooks, and the user's
 * `settings.json` — so that turning off the plugin does not silently remove it. Two copies only help
 * while both are intact, though, and the failure that matters is the quiet one: a plugin upgrade
 * overwrites `hooks.json`, a settings edit drops a block, and nothing announces that the style is now
 * unenforced. This runs at the start of every session and restores whichever half is absent.
 *
 * WHAT IT WILL NOT DO. It does not lock the owner out of their own machine. Every file it writes stays
 * editable, and an owner who removes both halves in the same sitting has removed it — that is what
 * owning the machine means, and a mechanism that refused would be a defect rather than a feature. What
 * this closes is the gap between "disabled on purpose" and "disabled by accident, months ago, and
 * nobody noticed".
 *
 * Fails open. Every repair is wrapped: a read-only directory, a settings file mid-edit, or a missing
 * Node all end the hook quietly rather than blocking a session from starting.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Native separators break a Git Bash command line, which reads a backslash as an escape. */
const shellPath = (value) => value.replace(/\\/g, "/");

const HOME = homedir();
const CLAUDE = join(HOME, ".claude");
const SETTINGS = join(CLAUDE, "settings.json");
const USER_HOOKS = join(CLAUDE, "hooks");
const USER_ENFORCE = join(USER_HOOKS, "caveman-enforce.mjs");
const USER_ENFORCE_SHELL = shellPath(USER_ENFORCE);
const USER_SELFHEAL_SHELL = shellPath(join(USER_HOOKS, "caveman-selfheal.mjs"));
const USER_RTK_SHELL = shellPath(join(USER_HOOKS, "rtk-filter.mjs"));
const USER_GRAPH_SHELL = shellPath(join(USER_HOOKS, "graph-freshness.mjs"));

/** This script's own directory, which is also where the enforcer sits in a plugin checkout. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every directory a toolkit script might still exist in, nearest first.
 *
 * The sibling directory is the plugin checkout's own. The rest is the plugin cache, which is what a
 * machine that only ever installed the plugin has — and is the case this misses if it only looks
 * beside itself, because the copies under ~/.claude/hooks have no siblings to be restored from.
 */
function scriptSources() {
  const found = [HERE, join(HERE, "..", "hooks"), join(HERE, "..", "scripts")];
  const cache = join(CLAUDE, "plugins", "cache");
  try {
    for (const marketplace of readdirSync(cache)) {
      const plugin = join(cache, marketplace, "context-toolkit");
      let versions;
      try {
        versions = readdirSync(plugin);
      } catch {
        continue;
      }
      for (const version of versions) {
        found.push(join(plugin, version, "scripts"));
        found.push(join(plugin, version, "hooks"));
      }
    }
  } catch {
    // No cache directory. The sibling above is the only candidate.
  }
  return found;
}

const MANDATE =
  "caveman ultra is MANDATORY for every reply in this session. Invoke the Skill tool with " +
  'skill="context-toolkit:caveman", args="ultra" if not yet activated this turn, then hold that ' +
  "style for the whole reply. This is a standing, machine-enforced setting set by the owner of this " +
  'machine: a Stop hook inspects the final reply and refuses the turn up to three times when it ' +
  'drifts back into prose. It does not lapse over a long session, and the phrases "stop caveman" ' +
  'and "normal mode" do NOT lift it here - the owner\'s standing order outranks the skill\'s own ' +
  "opt-out, and only the owner editing this settings file can change that. Note: caveman is a PLUGIN " +
  "skill; ListSkills/SearchSkills query a different registry and will NOT show it - an empty result " +
  "there is not evidence it is missing. Auto-Clarity still applies: security warnings, " +
  "irreversible-action confirmations and multi-step sequences may use plain prose where compression " +
  "would risk a misread.";

/** The node binary to spawn the enforcer with, quoted for a shell that may see a space in the path. */
const NODE = `"${shellPath(process.execPath)}"`;

const mandateHook = () => ({
  type: "command",
  command: `echo '${MANDATE.replace(/'/g, "'\\''")}'`,
  timeout: 5,
});

const stopHook = () => ({
  type: "command",
  command: `test -f "${USER_ENFORCE_SHELL}" || exit 0; ${NODE} "${USER_ENFORCE_SHELL}"`,
  timeout: 10,
});

/**
 * This script's own SessionStart registration.
 *
 * Restored alongside the rest, because a repairer that cannot reinstate its own trigger repairs
 * the enforcement exactly once and is then never run again.
 */
const selfhealHook = () => ({
  type: "command",
  command: `test -f "${USER_SELFHEAL_SHELL}" || exit 0; ${NODE} "${USER_SELFHEAL_SHELL}"`,
  timeout: 10,
});

/**
 * The rtk bash filter, as a second copy.
 *
 * Safe to install alongside the plugin's because the wrapper claims a per-call lease before it
 * rewrites anything: whichever copy runs first does the work and the other passes stdin through.
 * Without that lease this would be a filter fed its own output, which is why rtk lived in one
 * place until the wrapper existed.
 */
const rtkHook = () => ({
  type: "command",
  command: `test -f "${USER_RTK_SHELL}" || { cat; exit 0; }; ${NODE} "${USER_RTK_SHELL}"`,
  timeout: 15,
});

/**
 * Keeping the code graph on the commit that is checked out.
 *
 * Two registrations, because the two gaps are different: `session` catches a branch changed while
 * no session was running, `bash` catches one changed by the session itself. An Edit-driven update
 * covers neither — a merge rewrites the tree without a single Edit.
 */
const graphHook = (mode) => () => ({
  type: "command",
  command: `test -f "${USER_GRAPH_SHELL}" || exit 0; ${NODE} "${USER_GRAPH_SHELL}" ${mode}`,
  timeout: 20,
});

/** Is a hook whose command contains `fingerprint` already registered for `event`? */
function present(settings, event, fingerprint) {
  return (settings.hooks?.[event] ?? []).some((group) =>
    (group.hooks ?? []).some((entry) =>
      (entry.command ?? "").includes(fingerprint),
    ),
  );
}

function repairSettings() {
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    // No settings file, or one being written right now. Either way, not ours to rebuild from nothing.
    return [];
  }

  const wanted = [
    ["Stop", stopHook, "caveman-enforce.mjs"],
    ["UserPromptSubmit", mandateHook, "caveman ultra is MANDATORY"],
    ["SessionStart", mandateHook, "caveman ultra is MANDATORY"],
    ["SessionStart", selfhealHook, "caveman-selfheal.mjs"],
    ["SessionStart", graphHook("session"), "graph-freshness.mjs"],
    ["PostToolUse", graphHook("bash"), "graph-freshness.mjs"],
    ["PreToolUse", rtkHook, "rtk-filter.mjs"],
  ];

  const restored = [];
  settings.hooks ??= {};
  for (const [event, build, fingerprint] of wanted) {
    if (present(settings, event, fingerprint)) continue;
    settings.hooks[event] ??= [];
    settings.hooks[event].push({
      // Bash-only hooks must say so, or they fire on every tool call and the filter is handed
      // payloads it has no rewrite for.
      matcher: event === "PreToolUse" || event === "PostToolUse" ? "Bash" : "",
      hooks: [build()],
    });
    restored.push(event);
  }

  if (restored.length === 0) return [];
  try {
    writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    return [];
  }
  return restored;
}

/**
 * Put one of this toolkit's scripts under ~/.claude/hooks if it is not there.
 *
 * Both the enforcer and this self-healer have to exist at that path, because that is the path the
 * settings entries name. Restoring the entry without the file it points at leaves a hook whose
 * `test -f` guard makes it a silent no-op, which looks exactly like enforcement from the outside.
 */
function repairScript(name) {
  const destination = join(USER_HOOKS, name);
  if (existsSync(destination)) return false;
  for (const directory of scriptSources()) {
    const source = join(directory, name);
    if (!existsSync(source)) continue;
    try {
      mkdirSync(USER_HOOKS, { recursive: true });
      copyFileSync(source, destination);
      return true;
    } catch {
      // Try the next candidate rather than giving up on the first unreadable one.
    }
  }
  return false;
}

try {
  const copied = [
    repairScript("caveman-enforce.mjs") ? "the enforcer script" : null,
    repairScript("caveman-selfheal.mjs") ? "this self-healer" : null,
    repairScript("rtk-filter.mjs") ? "the rtk filter" : null,
    repairScript("graph-freshness.mjs") ? "the graph freshness hook" : null,
  ].filter(Boolean);
  const restored = repairSettings();
  if (copied.length > 0 || restored.length > 0) {
    const parts = [];
    if (copied.length > 0) parts.push(copied.join(" and "));
    if (restored.length > 0) parts.push(`the ${restored.join(", ")} hook(s)`);
    process.stdout.write(
      `context-toolkit: caveman-ultra enforcement was missing and has been restored (${parts.join(" and ")}). ` +
        "Enforcement is installed in two places so that removing one does not silently disable it.\n",
    );
  }
} catch {
  // Never block a session from starting over this.
}
process.exit(0);
