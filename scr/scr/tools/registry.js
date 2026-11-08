
import { calculate } from "./calculator.js";
import { createWebSearch } from "./webSearch.js";

export function createToolRegistry(config) {
  const search = createWebSearch(config);

  const tools = new Map([
    [
      "calculator",
      {
        name: "calculator",
        description:
          "Evaluate a mathematical expression using basic arithmetic operations.",
        available: true,

        parameters: {
          type: "OBJECT",
          properties: {
            expression: {
              type: "STRING",
              description: "The mathematical expression to calculate.",
            },
          },
          required: ["expression"],
        },

        execute: async ({ expression }) => {
          if (
            typeof expression !== "string" ||
            expression.length > 200
          ) {
            throw new Error("Invalid calculator expression.");
          }

          return calculate(expression);
        },
      },
    ],

    [
      "web_search",
      {
        name: "web_search",
        description:
          "Search the internet for current information and relevant sources.",
        available: Boolean(search?.available),

        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "The search query.",
            },
          },
          required: ["query"],
        },

        execute: async ({ query }) => {
          if (
            typeof query !== "string" ||
            !query.trim() ||
            query.length > 500
          ) {
            throw new Error("Invalid search query.");
          }

          if (!search?.available) {
            throw new Error("Web search is unavailable.");
          }

          return search.execute({ query: query.trim() });
        },
      },
    ],
  ]);

  return tools;
}
