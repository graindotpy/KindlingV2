import { describe, expect, it } from "vitest";
import {
  filterAndRankBooksByTitle,
  getBookTitleMatchKind,
  matchesLibraryQuery,
  normalizeSearchQuery,
} from "@/lib/search/query";

describe("search identifiers", () => {
  it.each([
    ["https://www.goodreads.com/book/show/135479.The_Borrowers", "edition:135479"],
    ["https://goodreads.com/work/editions/2624492", "work:2624492"],
    ["https://goodreads.com/author/show/19109.Mary_Norton", "author:19109"],
    ["HTTPS://WWW.GOODREADS.COM/BOOK/SHOW/135479.The_Borrowers", "edition:135479"],
    ["https://m.goodreads.com/work/show/2624492", "work:2624492"],
    ["978-0-15-204737-5", "isbn:9780152047375"],
    ["ISBN-10: 0-15-204737-9", "isbn:0152047379"],
    ["ISBN: 978-0-15-204737-5", "isbn:9780152047375"],
    ["WORK: 2624492", "work:2624492"],
    ["https://goodreads.com.evil.test/book/show/135479", "https://goodreads.com.evil.test/book/show/135479"],
    ["  The   Borrowers  ", "The Borrowers"],
  ])("normalizes %s without confusing work and edition IDs", (input, expected) => {
    expect(normalizeSearchQuery(input)).toBe(expected);
  });

  it("uses the correct identifier field when matching the local library", () => {
    const book = { title: "The Borrowers", foreignBookId: "42", author: { authorName: "Mary Norton", foreignAuthorId: "9" }, editions: [{ foreignEditionId: "81", isbn13: "9780152047375" }] };
    expect(matchesLibraryQuery(book, "work:42")).toBe(true);
    expect(matchesLibraryQuery(book, "edition:42")).toBe(false);
    expect(matchesLibraryQuery(book, "edition:81")).toBe(true);
    expect(matchesLibraryQuery(book, "isbn:9780152047375")).toBe(true);
    expect(matchesLibraryQuery(book, "author:9")).toBe(true);
  });
});

describe("resolved book title matching", () => {
  it.each([
    ["L'Étranger", "L Etranger", "exact"],
    ["The Borrowers (The Borrowers, #1)", "The Borrowers", "parenthetical"],
    ["The Borrowers", "The Borrowers: A Novel", "base"],
    ["The Borrowers: A Novel", "The Borrowers", "subtitle"],
    [
      "TheName of theWind (Kingkiller Chronicles, Day 1)2nd (second) edition Text Only",
      "The Name of the Wind",
      "provider-artifact",
    ],
    ["TheName of theWind", "The Name of the Wind", "provider-artifact"],
    [
      "The Name of the Wind 2nd (second) edition Text Only",
      "The Name of the Wind",
      "provider-artifact",
    ],
    ["The Bonehunters (The Malazan Book of the Fallen, #6)", "Bonehunters", "parenthetical"],
    ["Bonehunters", "The Bonehunters", "parenthetical"],
    ["A Game of Thrones", "Game of Thrones", "parenthetical"],
    ["The Bonehunters' Revenge", "Bonehunters", "none"],
    ["Chronicles: Volume Two", "Chronicles: Volume One", "none"],
    ["Firefight", "Fire", "none"],
    ["The Name of the Window 2nd edition Text Only", "The Name of the Wind", "none"],
    ["TheName and theWind 2nd edition Text Only", "The Name of the Wind", "none"],
    ["TheName of theWindup 2nd edition Text Only", "The Name of the Wind", "none"],
    ["Therapist", "The Rapist", "none"],
    ["thename of thewind", "The Name of the Wind", "none"],
    ["Second Edition Murder", "Second Murder", "none"],
  ])("matches %s against %s as %s", (candidate, target, expected) => {
    expect(getBookTitleMatchKind(candidate, target)).toBe(expected);
  });

  it("filters unrelated works and ranks exact, parenthetical, then subtitle matches", () => {
    const books = [
      { title: "The Borrowers: A Novel", id: "subtitle" },
      { title: "The Borrowers (Illustrated Edition)", id: "parenthetical" },
      { title: "The Borrowers Afloat", id: "unrelated" },
      { title: "The Borrowers", id: "exact" },
      { title: "Les Chapardeurs", id: "alternate" },
      { title: "TheBorrowers 2nd edition Text Only", id: "provider-artifact" },
    ];

    expect(filterAndRankBooksByTitle(books, {
      targetTitle: "The Borrowers",
      alternateTitles: ["Les Chapardeurs"],
    }).map((book) => book.id)).toEqual([
      "exact",
      "alternate",
      "parenthetical",
      "subtitle",
      "provider-artifact",
    ]);
  });
});
