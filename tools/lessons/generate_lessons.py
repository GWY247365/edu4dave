#!/usr/bin/env python3
"""
Builds lessons.json: the mini-lessons the app shows when Dave makes a mistake
it can name (see catalog.json). Runs on your own computer with your API key,
through the Message Batches API (half price), and draws on the promotional
credits. The finished file is static: the app never calls Claude, so it works
offline and in Hong Kong.

Pipeline (all automatic with `run`):
  1. write   Claude Opus writes VARIANTS versions of each lesson.
  2. check   this script recomputes every "=" in the correct working.
  3. review  a second Opus pass reviews each lesson as a maths teacher would.
  4. retry   lessons that fail are rewritten once, with the reviewer's notes.
  5. save    passing versions go to lessons.json; anything still failing is
             listed so a person can decide.

Usage (from this folder):
  pip3 install anthropic
  python3 generate_lessons.py run              # everything, priority 1 first
  python3 generate_lessons.py run --pilot      # 3 lessons, to see quality and cost
  python3 generate_lessons.py run --priority 1 # only Dave's most common mistakes
  python3 generate_lessons.py status           # where a run is up to

The API key is asked for when needed (typing is hidden) or read from
ANTHROPIC_API_KEY. It is never written to disk.
"""

import argparse
import getpass
import json
import os
import re
import sys
import time
from datetime import date
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).parent
CATALOG = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
STATE = ROOT / "state.json"
OUT = ROOT / "lessons.json"

MODEL = "claude-opus-5-5"
VARIANTS = 3
# Batch prices per million tokens for the model above (USD), for the estimate.
PRICE_IN, PRICE_OUT = 2.0, 10.0

LESSON_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "3-7 words, friendly, names the idea (not the mistake)"},
        "mistake": {"type": "string", "description": "1-2 short sentences: what happened, kindly, with the example numbers"},
        "example": {"type": "string", "description": "the problem the lesson works on, e.g. '38 ÷ 6' or 'a 6 cm by 4 cm rectangle'"},
        "wrong": {"type": "object", "properties": {
            "label": {"type": "string", "description": "e.g. 'The mix-up'"},
            "lines": {"type": "array", "items": {"type": "string"}, "description": "1-4 short lines showing the mistaken working on the example"}},
            "required": ["label", "lines"]},
        "right": {"type": "object", "properties": {
            "label": {"type": "string", "description": "e.g. 'The right way'"},
            "lines": {"type": "array", "items": {"type": "string"}, "description": "1-6 short lines of correct working on the SAME example"}},
            "required": ["label", "lines"]},
        "steps": {"type": "array", "description": "2-5 worked steps on the example, each with a subgoal label",
                  "items": {"type": "object", "properties": {
                      "goal": {"type": "string", "description": "subgoal label, 2-5 words, e.g. 'Find the biggest that fits'"},
                      "text": {"type": "string", "description": "one or two short sentences doing that step"}},
                      "required": ["goal", "text"]}},
        "check": {"type": "object", "description": "a self-explanation question about WHY, not a new sum to do",
                  "properties": {
                      "question": {"type": "string"},
                      "options": {"type": "array", "items": {"type": "object", "properties": {
                          "text": {"type": "string"},
                          "correct": {"type": "boolean"},
                          "feedback": {"type": "string", "description": "1-2 sentences shown after he picks this option"}},
                          "required": ["text", "correct", "feedback"]}}},
                  "required": ["question", "options"]},
        "remember": {"type": "string", "description": "the rule to keep, under 15 words"},
    },
    "required": ["title", "mistake", "example", "wrong", "right", "steps", "check", "remember"],
}
WRITE_TOOL = {"name": "save_lesson", "description": "Save the finished mini-lesson.", "input_schema": LESSON_SCHEMA}
REVIEW_TOOL = {
    "name": "save_review", "description": "Save the review verdict.",
    "input_schema": {"type": "object", "properties": {
        "pass": {"type": "boolean", "description": "true only if a careful teacher would show this to the child as it is"},
        "issues": {"type": "array", "items": {"type": "string"}, "description": "each concrete problem; empty if it passes"},
        "scores": {"type": "object", "properties": {
            "maths": {"type": "integer", "description": "1-5: every statement is mathematically true"},
            "targets_mistake": {"type": "integer", "description": "1-5: it addresses exactly this mistake and its cause"},
            "child_fit": {"type": "integer", "description": "1-5: short, clear, kind English an 8-year-old can read"},
            "self_explanation": {"type": "integer", "description": "1-5: the check question makes him explain why, has one defensible answer, and its feedback teaches"}},
            "required": ["maths", "targets_mistake", "child_fit", "self_explanation"]}},
        "required": ["pass", "issues", "scores"]}}

WRITER_SYSTEM = f"""You write mini-lessons for a children's maths practice app. The lesson appears right after the child makes one specific, recognised mistake, and he reads it on an iPad.

The learner: {CATALOG['learner']}

Write each lesson the way the research on learning from errors says works:
- Name the mistake kindly and specifically, with the numbers he saw; mistakes are normal while learning. Never say "easy", "simple" or "obviously"; praise effort and strategy, not cleverness.
- Contrast: show the mistaken working and the correct working on the SAME example side by side, so the one difference is easy to see (comparing incorrect and correct examples).
- Then a short worked example on that example, each step headed by a subgoal label (what the step is for), so he learns the method's structure and not just the answer.
- Then one self-explanation question about WHY a step is right or why the mistake does not work. Exactly one option is correct. The wrong options are the beliefs that cause this mistake, so picking one is useful: its feedback explains kindly. Do not ask him to do a new calculation there.
- End with one rule to remember.
- Use the app's own method and words (given with each lesson), so the lesson matches what he has already been taught.

Style: plain short sentences, common words, British/Hong Kong English spelling is fine. Numbers as digits. Use × ÷ − + and "R" for remainders (7 R 5). Use units where the problem has them (cm, sq cm). No markdown, no emoji, no headings inside fields.

Accuracy rules (they are checked by a program): in the correct working ("right" and "steps") every "=" must be exactly true. For an estimate write "about" or "≈", never "=". The "wrong" lines must show the actual mistake described, with its real wrong result. Keep every field short: the whole lesson must fit on a tablet screen with little scrolling."""

REVIEWER_SYSTEM = """You review mini-lessons for a children's maths app before a child sees them. You are an experienced primary maths teacher who knows the research on worked examples, learning from errors and self-explanation. Be strict: a lesson that is unclear, too long, slightly wrong, off-target or confusing for an 8-year-old must fail, with each problem stated concretely so a writer can fix it.

Check every statement and every number yourself, including the mistaken working (it must show the described mistake faithfully). Check that the correct working and the steps use the method described, that the check question has exactly one defensible correct option and does not need new arithmetic, that each option's feedback is correct and kind, and that nothing says "easy", "simple" or "obviously"."""


def lesson_prompt(entry, variant, feedback=None):
    p = (f"Mistake key: {entry['key']}\nTopic: {entry['domain']}\n"
         f"The mistake: {entry['mistake']}\n"
         f"How the app teaches it (use these words and this method): {entry['method']}\n"
         f"Numbers to use: {entry['example_rules']}\n\n"
         f"This is version {variant + 1} of {VARIANTS} of this lesson. He may see several versions over time, so "
         + ("you may use the example in the description." if variant == 0 else
            "choose DIFFERENT numbers from the example in the description, and a slightly different check question.")
         + "\n\nWrite the lesson and save it with save_lesson.")
    if feedback:
        p += ("\n\nAn earlier version of this lesson was rejected by a reviewer for these reasons. "
              "Write a new version that fixes all of them:\n- " + "\n- ".join(feedback))
    return p


def review_prompt(entry, lesson):
    return (f"Mistake this lesson must address: {entry['mistake']}\n"
            f"Method the app uses: {entry['method']}\n"
            f"Learner: {CATALOG['learner']}\n\nLesson (JSON):\n{json.dumps(lesson, ensure_ascii=False, indent=1)}\n\n"
            "Review it and save the verdict with save_review.")


# ---------- the arithmetic check ----------
NUM_CHUNK = re.compile(r"[\d(][\d\s+\-−×x*÷/()R=]*[\d)]")
REM = re.compile(r"^\s*(\d+)\s*R\s*(\d+)\s*$")
DIV = re.compile(r"^\s*(\d+)\s*÷\s*(\d+)\s*$")


def evaluate(expr):
    """Exact value of a plain arithmetic expression, or None if it is not one."""
    e = expr.replace("×", "*").replace("x", "*").replace("÷", "/").replace("−", "-").strip()
    if not re.fullmatch(r"[\d\s+\-*/()]+", e) or not re.search(r"\d", e):
        return None
    if not re.search(r"[+\-*/]", e):
        return Fraction(int(e.replace(" ", ""))) if re.fullmatch(r"\s*\d+\s*", e) else None
    tokens = re.findall(r"\d+|[+\-*/()]", e)
    py = "".join(f"Fraction({t})" if t.isdigit() else t for t in tokens)
    try:
        return eval(py, {"__builtins__": {}, "Fraction": Fraction})
    except Exception:
        return None


def check_line(line):
    """Problems with the '=' statements in one line of correct working."""
    problems = []
    for chunk in NUM_CHUNK.findall(line):
        if "=" not in chunk:
            continue
        parts = [p for p in chunk.split("=")]
        prev = None
        for part in parts:
            rm = REM.match(part)
            if rm and prev is not None:
                q, r = int(rm.group(1)), int(rm.group(2))
                d = DIV.match(prev[1])
                if d:
                    a, b = int(d.group(1)), int(d.group(2))
                    if b * q + r != a or r >= b:
                        problems.append(f"'{prev[1].strip()} = {part.strip()}' is wrong")
                prev = (None, part)
                continue
            val = evaluate(part)
            if val is not None and prev is not None and prev[0] is not None and val != prev[0]:
                problems.append(f"'{prev[1].strip()} = {part.strip()}' is wrong ({prev[0]} vs {val})")
            prev = (val, part)
    return problems


def validate(lesson):
    """Problems a program can see: arithmetic in the correct working, shape, length."""
    probs = []
    for line in lesson.get("right", {}).get("lines", []) + [s.get("text", "") for s in lesson.get("steps", [])]:
        probs += check_line(line)
    opts = lesson.get("check", {}).get("options", [])
    if len(opts) < 2 or sum(1 for o in opts if o.get("correct")) != 1:
        probs.append("the check question must have exactly one correct option")
    if not 2 <= len(lesson.get("steps", [])) <= 5:
        probs.append("there must be 2-5 steps")
    if not lesson.get("wrong", {}).get("lines") or not lesson.get("right", {}).get("lines"):
        probs.append("both the mistaken and the correct working are needed")
    text = json.dumps(lesson, ensure_ascii=False)
    words = len(re.findall(r"\w+", text))
    if words > 420:
        probs.append(f"too long for a tablet screen ({words} words; keep it under about 350)")
    for bad in ("easy", "simple", "obviously"):
        if re.search(rf"\b{bad}\b", text, re.I):
            probs.append(f"uses the word '{bad}'")
    return probs


# ---------- batches ----------
def client():
    try:
        import anthropic
    except ImportError:
        sys.exit("Install the SDK first:  pip3 install anthropic")
    key = os.environ.get("ANTHROPIC_API_KEY") or getpass.getpass("Paste your API key and press Enter (it stays hidden): ").strip()
    if not key:
        sys.exit("No API key given.")
    return anthropic.Anthropic(api_key=key)


def submit(cl, requests):
    b = cl.messages.batches.create(requests=requests)
    print(f"  submitted batch {b.id} ({len(requests)} requests)")
    return b.id


def wait(cl, batch_id):
    t0 = time.time()
    while True:
        b = cl.messages.batches.retrieve(batch_id)
        c = b.request_counts
        print(f"  {b.processing_status}: {c.succeeded} done, {c.processing} working, {c.errored} errors"
              f"  ({int(time.time() - t0) // 60} min)", flush=True)
        if b.processing_status == "ended":
            return
        time.sleep(60)


ERRORS = []  # what the API said about failed requests, shown to the user


def error_text(result):
    err = getattr(result, "error", None)
    inner = getattr(err, "error", None) or err
    msg = getattr(inner, "message", None) or str(inner or result.type)
    kind = getattr(inner, "type", None) or result.type
    return f"{kind}: {msg}"


def results(cl, batch_id, usage):
    out = {}
    for item in cl.messages.batches.results(batch_id):
        if item.result.type != "succeeded":
            out[item.custom_id] = None
            ERRORS.append(error_text(item.result))
            continue
        msg = item.result.message
        usage["in"] += msg.usage.input_tokens
        usage["out"] += msg.usage.output_tokens
        tool = next((blk for blk in msg.content if blk.type == "tool_use"), None)
        out[item.custom_id] = tool.input if tool else None
    return out


def write_requests(entries, feedback=None):
    reqs = []
    for e in entries:
        for v in range(VARIANTS):
            cid = f"{e['key']}#{v}"
            if feedback is not None and cid not in feedback:
                continue
            reqs.append({"custom_id": cid.replace(".", "_").replace("#", "__"), "params": {
                "model": MODEL, "max_tokens": 4000, "system": WRITER_SYSTEM,
                "tools": [WRITE_TOOL], "tool_choice": {"type": "tool", "name": "save_lesson"},
                "messages": [{"role": "user", "content": lesson_prompt(e, v, feedback and feedback.get(cid))}]}})
    return reqs


def review_requests(entries, lessons):
    by_key = {e["key"]: e for e in entries}
    reqs = []
    for cid, lesson in lessons.items():
        e = by_key[cid.split("#")[0]]
        reqs.append({"custom_id": cid.replace(".", "_").replace("#", "__"), "params": {
            "model": MODEL, "max_tokens": 2000, "system": REVIEWER_SYSTEM,
            "tools": [REVIEW_TOOL], "tool_choice": {"type": "tool", "name": "save_review"},
            "messages": [{"role": "user", "content": review_prompt(e, lesson)}]}})
    return reqs


def unmangle(custom_id, entries):
    # custom_id allows only [a-zA-Z0-9_-]; map it back to "key#variant".
    for e in entries:
        stem = e["key"].replace(".", "_") + "__"
        if custom_id.startswith(stem) and custom_id[len(stem):].isdigit():
            return f"{e['key']}#{custom_id[len(stem):]}"
    return custom_id


def one_round(cl, entries, usage, feedback=None):
    """Write (or rewrite) lessons, check them in code, review them. Returns
    (passed {cid: lesson}, failed {cid: [issues]})."""
    print("Writing lessons..." if feedback is None else f"Rewriting {len(feedback)} lessons with the reviewer's notes...")
    bid = submit(cl, write_requests(entries, feedback))
    wait(cl, bid)
    ERRORS.clear()
    raw = {unmangle(k, entries): v for k, v in results(cl, bid, usage).items()}
    if raw and all(v is None for v in raw.values()):
        # Every request failed: the same API problem would fail the rewrite
        # too, so stop and say what it was instead of spending a second round.
        print("\nEvery request failed. The API said:")
        for e in sorted(set(ERRORS)):
            print("  " + e)
        sys.exit("\nNothing was charged for failed requests. Send this message in the chat to get it fixed.")
    passed, failed, to_review = {}, {}, {}
    for cid, lesson in raw.items():
        if lesson is None:
            failed[cid] = ["the request failed: " + (ERRORS[0] if ERRORS else "unknown error")]
            continue
        probs = validate(lesson)
        if probs:
            failed[cid] = probs
        else:
            to_review[cid] = lesson
    print(f"  arithmetic and shape check: {len(to_review)} ok, {len(failed)} need fixing")
    if to_review:
        print("Reviewing...")
        rid = submit(cl, review_requests(entries, to_review))
        wait(cl, rid)
        verdicts = {unmangle(k, entries): v for k, v in results(cl, rid, usage).items()}
        for cid, lesson in to_review.items():
            v = verdicts.get(cid)
            scores = (v or {}).get("scores", {})
            good = v and v.get("pass") and all(scores.get(s, 0) >= 4 for s in ("maths", "targets_mistake", "child_fit", "self_explanation"))
            if good:
                lesson["_review"] = scores
                passed[cid] = lesson
            else:
                failed[cid] = (v or {}).get("issues") or ["the review did not pass it"]
    return passed, failed


def cmd_run(args):
    global MODEL, PRICE_IN, PRICE_OUT
    if args.model:
        MODEL = args.model
        PRICE_IN, PRICE_OUT = {"claude-sonnet-5-5": (1.0, 5.0), "claude-haiku-5-5": (0.05, 0.25)}.get(MODEL, (PRICE_IN, PRICE_OUT))
    entries = [e for e in CATALOG["lessons"] if args.priority is None or e["priority"] <= args.priority]
    entries.sort(key=lambda e: e["priority"])
    if args.pilot:
        entries = [e for e in entries if e["key"] in ("ldiv.zeroskip", "geo.mix", "mul.stuck")]
    # A rerun only writes lessons that have no passing version yet, unless
    # --redo asks for everything again.
    done = set(json.loads(OUT.read_text(encoding="utf-8")).get("lessons", {})) if OUT.exists() and not args.redo else set()
    entries = [e for e in entries if e["key"] not in done]
    if not entries:
        sys.exit(f"Every selected lesson already has a passing version in {OUT.name} (use --redo to write them again).")
    n = len(entries) * VARIANTS
    print(f"{len(entries)} lessons × {VARIANTS} versions = {n} lessons to write and review with {MODEL} (batch, half price).")
    print(f"Rough cost: about ${n * 0.04:.2f}-{n * 0.08:.2f} including reviews and rewrites. Spend shows in the Console.")
    if input("Start? (y/n) ").strip().lower() != "y":
        sys.exit("Cancelled.")
    cl = client()
    usage = {"in": 0, "out": 0}
    passed, failed = one_round(cl, entries, usage)
    if failed:
        p2, failed = one_round(cl, entries, usage, feedback=failed)
        passed.update(p2)
    save(passed, entries)
    cost = usage["in"] / 1e6 * PRICE_IN + usage["out"] / 1e6 * PRICE_OUT
    STATE.write_text(json.dumps({"finished": time.strftime("%Y-%m-%d %H:%M"), "passed": sorted(passed),
                                 "failed": failed, "tokens": usage, "cost_usd": round(cost, 2)}, ensure_ascii=False, indent=1))
    print(f"\nDone. {len(passed)} lesson versions passed; saved to {OUT.name}.")
    print(f"Tokens: {usage['in']:,} in, {usage['out']:,} out, about ${cost:.2f} (the Console has the exact figure).")
    if failed:
        print(f"{len(failed)} versions still failed after one rewrite (details in {STATE.name}):")
        for cid, issues in failed.items():
            print(f"  {cid}: {issues[0]}")
    missing = [e["key"] for e in entries if not any(c.startswith(e["key"] + "#") for c in passed)]
    if missing:
        print("No passing version yet for: " + ", ".join(missing) + " (run again with the same options to retry them).")
    print(f"\nNext: send {OUT.name} back in the chat, and it will be checked again and added to the app.")


def save(passed, entries):
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"lessons": {}}
    lessons = old.get("lessons", {})
    for e in entries:
        mine = [passed[c] for c in sorted(passed) if c.split("#")[0] == e["key"]]
        if mine:
            lessons[e["key"]] = mine
    OUT.write_text(json.dumps({"version": 1, "generated": date.today().isoformat(), "model": MODEL,
                               "lessons": lessons}, ensure_ascii=False, indent=1), encoding="utf-8")


def cmd_errors(args):
    cl = client()
    seen = {}
    for item in cl.messages.batches.results(args.batch_id):
        if item.result.type != "succeeded":
            e = error_text(item.result)
            seen[e] = seen.get(e, 0) + 1
    if not seen:
        print("No failed requests in that batch.")
    for e, n in seen.items():
        print(f"{n} × {e}")


def cmd_status(args):
    if not STATE.exists():
        sys.exit("No finished run yet.")
    s = json.loads(STATE.read_text(encoding="utf-8"))
    print(f"Last run {s['finished']}: {len(s['passed'])} passed, {len(s['failed'])} failed, about ${s['cost_usd']}.")
    for cid, issues in s["failed"].items():
        print(f"  {cid}: {'; '.join(issues)}")


def main():
    p = argparse.ArgumentParser(description="Build the app's mini-lesson library.")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--pilot", action="store_true", help="3 lessons only, to check quality and cost")
    r.add_argument("--priority", type=int, choices=[1, 2, 3], help="only lessons up to this priority")
    r.add_argument("--redo", action="store_true", help="write lessons again even if lessons.json has them")
    r.add_argument("--model", help="use another model, e.g. claude-sonnet-5-5")
    sub.add_parser("status")
    e = sub.add_parser("errors", help="show why the requests in a batch failed")
    e.add_argument("batch_id")
    args = p.parse_args()
    {"run": cmd_run, "status": cmd_status, "errors": cmd_errors}[args.cmd](args)


if __name__ == "__main__":
    main()
