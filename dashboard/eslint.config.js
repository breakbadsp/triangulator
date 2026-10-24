import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["src/lib/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "location",
        "localStorage",
        "sessionStorage",
        "fetch",
        "setTimeout",
        "setInterval",
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now" },
      ],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
