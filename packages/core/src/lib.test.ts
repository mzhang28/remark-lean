import { describe, test, expect } from "bun:test";
import { findCommentTokens } from "./lib.ts";

/** Renders the substrings a token list covers, for readable assertions. */
const covered = (lines: string[]) =>
  findCommentTokens(lines).map((t) =>
    (lines[t.line] || "").substring(t.start, t.start + t.length)
  );

describe("findCommentTokens", () => {
  test("no comments", () => {
    expect(findCommentTokens(["def f (x : Nat) := x + 1"])).toEqual([]);
  });

  test("line comment", () => {
    const lines = ["def f := 1 -- adds one"];
    expect(findCommentTokens(lines)).toEqual([
      { line: 0, start: 11, length: 11, type: "comment" },
    ]);
    expect(covered(lines)).toEqual(["-- adds one"]);
  });

  test("whole-line comment", () => {
    expect(covered(["-- a note", "def f := 1"])).toEqual(["-- a note"]);
  });

  test("doc comment", () => {
    expect(covered(["/-- Doubles `n`. -/", "def d (n : Nat) := 2 * n"])).toEqual([
      "/-- Doubles `n`. -/",
    ]);
  });

  test("block comment spans lines", () => {
    expect(covered(["/- first", "second", "third -/ def f := 1"])).toEqual([
      "/- first",
      "second",
      "third -/",
    ]);
  });

  test("nested block comments", () => {
    expect(covered(["/- outer /- inner -/ still -/ def f := 1"])).toEqual([
      "/- outer /- inner -/ still -/",
    ]);
  });

  test("block comment inline between code", () => {
    expect(covered(["def f /- why -/ := 1 /- and -/"])).toEqual([
      "/- why -/",
      "/- and -/",
    ]);
  });

  test("comment markers inside strings are code", () => {
    expect(findCommentTokens(['#eval "-- not a comment"'])).toEqual([]);
    expect(findCommentTokens(['#eval "/- nor this -/"'])).toEqual([]);
  });

  test("escaped quote does not end the string", () => {
    expect(findCommentTokens(['#eval "a \\" -- b"'])).toEqual([]);
  });

  test("string after a comment on the same line stays inside the comment", () => {
    expect(covered(['def f := 1 -- see "x"', "def g := 2 -- ok"])).toEqual([
      '-- see "x"',
      "-- ok",
    ]);
  });

  test("block comment swallows quotes", () => {
    expect(covered(['/- a " b -/ def f := 1 -- end'])).toEqual([
      '/- a " b -/',
      "-- end",
    ]);
  });

  test("empty lines inside a block comment produce no tokens", () => {
    expect(findCommentTokens(["/- a", "", "b -/"]).map((t) => t.line)).toEqual([
      0, 2,
    ]);
  });
});
