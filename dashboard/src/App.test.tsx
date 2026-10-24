import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { App } from "./App";

test("renders the dashboard root", () => {
  render(<App />);
  expect(screen.getByRole("main", { name: "Dashboard" })).toBeDefined();
});
