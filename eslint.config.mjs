import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 ships flat configs of its own, so FlatCompat and its
// translation of the old `extends` strings are gone.
const config = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // We ship our own responsive image pipeline (sharp derivatives + srcset)
      // instead of the built-in optimiser, so <img> is deliberate here.
      "@next/next/no-img-element": "off",
      // New in eslint-plugin-react-hooks 7, which eslint-config-next 16 brings:
      // React Compiler readiness checks. What they flag — state set from an
      // effect, a ref read while rendering, a clock read outside the markup — is
      // tested behaviour in the editor, the admin forms and a few public
      // components, written before the rules existed, and the application does
      // not run the compiler. Reported, not failed, until that code is reworked
      // on its own terms rather than inside a framework upgrade.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
    },
  },
  globalIgnores([".next/**", ".data/**", "node_modules/**", "drizzle/**", "next-env.d.ts"]),
]);

export default config;
