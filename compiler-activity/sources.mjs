export const sources = [
  {
    id: "react-install",
    title: "React Compiler installation",
    url: "https://react.dev/learn/react-compiler/installation",
  },
  {
    id: "rspack",
    title: "Rspack React Compiler integration",
    url: "https://rspack.rs/guide/integrations/react#react-compiler",
  },
  {
    id: "rsbuild",
    title: "Rsbuild React plugin",
    url: "https://rsbuild.rs/plugins/list/plugin-react#reactcompiler",
  },
  {
    id: "oxc-docs",
    title: "OXC experimental React Compiler",
    url: "https://oxc.rs/docs/guide/usage/transformer/react-compiler.html",
  },
  {
    id: "oxc-source",
    title: "OXC compiler source",
    url: "https://github.com/oxc-project/oxc/tree/main/crates/oxc_react_compiler",
  },
  {
    id: "swc-docs",
    title: "SWC React Compiler configuration",
    url: "https://swc.rs/docs/configuration/react-compiler",
  },
  {
    id: "babel-source",
    title: "Babel compiler README",
    url: "https://github.com/react/react/blob/main/compiler/packages/babel-plugin-react-compiler/README.md",
  },
  {
    id: "rust-adapter",
    title: "React Rust Babel adapter",
    url: "https://github.com/react/react/tree/main/compiler/packages/babel-plugin-react-compiler-rust",
  },
  {
    id: "rust-core",
    title: "React Rust compiler crates",
    url: "https://github.com/react/react/tree/main/compiler/crates",
  },
];

export const tracks = [
  {
    id: "babel",
    name: "React / Babel",
    repo: "react/react",
    paths: ["compiler/packages/babel-plugin-react-compiler"],
    package: "babel-plugin-react-compiler",
    description: "The Babel plugin recommended by React's installation guide.",
  },
  {
    id: "rust",
    name: "React / Rust",
    repo: "react/react",
    paths: ["compiler/crates", "compiler/packages/babel-plugin-react-compiler-rust"],
    package: "react_compiler",
    description:
      "Upstream Rust compiler core and experimental Babel adapter. Shares React's compiler issue queue with Babel.",
  },
  {
    id: "oxc",
    name: "OXC",
    repo: "oxc-project/oxc",
    paths: ["crates/oxc_react_compiler"],
    package: "oxc-transform-react",
    description:
      "Experimental integration with compiler code vendored in OXC. This scope measures the compiler crate, not all OXC activity.",
  },
  {
    id: "swc",
    name: "SWC",
    repo: "swc-project/swc",
    paths: ["crates/swc_ecma_react_compiler"],
    package: "@swc/core",
    description:
      "Native SWC adapter using upstream Rust compiler crates. Adapter activity does not include all upstream core work.",
  },
];

export const issueScopes = [
  {
    repo: "react/react",
    name: "React compiler (shared)",
    label: "Component: React Compiler",
    coverage: "area-label",
    terms: ['label:"Component: React Compiler"'],
  },
  {
    repo: "oxc-project/oxc",
    name: "OXC compiler",
    label: "A-react-compiler",
    coverage: "area-label",
    terms: ["label:A-react-compiler"],
  },
  {
    repo: "swc-project/swc",
    name: "SWC compiler mentions",
    coverage: "text-matched",
    terms: [
      '"react compiler" in:title,body',
      '"react-compiler" in:title,body',
      '"reactCompiler" in:title,body',
    ],
  },
];

export const packages = [
  { name: "babel-plugin-react-compiler", registry: "npm", group: "compiler" },
  { name: "react_compiler", registry: "crates.io", group: "compiler" },
  { name: "babel-plugin-react-compiler-rust", registry: "npm", group: "compiler", optional: true },
  { name: "oxc-transform-react", registry: "npm", group: "compiler" },
  { name: "@swc/core", registry: "npm", group: "compiler" },
  { name: "@rspack/core", registry: "npm", group: "integration" },
  { name: "@rsbuild/core", registry: "npm", group: "integration" },
  { name: "@rsbuild/plugin-react", registry: "npm", group: "integration" },
];

export const research = {
  reviewedAt: "2026-10-23",
  findings: [
    {
      text: "React's installation guide recommends the Babel plugin. Source activity on main and published npm versions are separate signals.",
      sources: ["react-install", "babel-source"],
    },
    {
      text: "React's Rust compiler has a published crates.io distribution. A missing npm Rust adapter is not evidence that the Rust compiler is unpublished.",
      sources: ["rust-core", "rust-adapter"],
    },
    {
      text: "OXC explicitly describes its React Compiler support as experimental. Its manifest describes in-tree vendoring; the README's published-fork description differs. The pinned manifest is the implementation evidence used here.",
      sources: ["oxc-docs", "oxc-source"],
    },
    {
      text: "SWC's native adapter depends on upstream React Rust compiler crates. Rspack and Rsbuild expose that integration, rather than providing two more compiler engines.",
      sources: ["swc-docs", "rspack", "rsbuild"],
    },
  ],
  integrations: [
    {
      name: "Rspack",
      requirement: "@rspack/core >=2.1.0",
      configuration: "builtin:swc-loader / jsc.transform.reactCompiler",
      source: "rspack",
    },
    {
      name: "Rsbuild",
      requirement: "@rsbuild/core >=2.1.0",
      configuration: "@rsbuild/plugin-react / reactCompiler",
      source: "rsbuild",
    },
    {
      name: "SWC",
      requirement: "@swc/core >=1.15.43",
      configuration: "jsc.transform.reactCompiler",
      source: "swc-docs",
    },
  ],
};
