
export function createWebSearch(config) {
  const available = Boolean(config.WEB_SEARCH_API_KEY);

  return {
    name: "web_search",
    available,

    async execute({ query }) {
      if (!available) {
        throw new Error("WEB_SEARCH_NOT_CONFIGURED");
      }

      if (
        typeof query !== "string" ||
        !query.trim() ||
        query.length > 500
      ) {
        throw new Error("INVALID_SEARCH_QUERY");
      }

      const url = new URL(
        config.WEB_SEARCH_ENDPOINT ||
        "https://serpapi.com/search.json"
      );

      if (
        url.protocol !== "https:" ||
        url.hostname !== "serpapi.com"
      ) {
        throw new Error("INVALID_SEARCH_ENDPOINT");
      }

      url.searchParams.set("engine", "google");
      url.searchParams.set("q", query.trim());
      url.searchParams.set("api_key", config.WEB_SEARCH_API_KEY);
      url.searchParams.set("num", "5");
      url.searchParams.set("hl", "en");
      url.searchParams.set("gl", "ke");

      let response;

      try {
        response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error("WEB_SEARCH_NETWORK_ERROR");
      }

      if (!response.ok) {
        throw new Error("WEB_SEARCH_PROVIDER_ERROR");
      }

      let data;

      try {
        data = await response.json();
      } catch {
        throw new Error("WEB_SEARCH_INVALID_RESPONSE");
      }

      if (data.error) {
        throw new Error("WEB_SEARCH_PROVIDER_ERROR");
      }

      const results = (data.organic_results ?? [])
        .slice(0, 5)
        .map((item) => ({
          title: String(item.title ?? "").slice(0, 300),
          url: String(item.link ?? "").slice(0, 2000),
          snippet: String(item.snippet ?? "").slice(0, 1000),
        }))
        .filter((item) => {
          try {
            return new URL(item.url).protocol === "https:";
          } catch {
            return false;
          }
        });

      return {
        query: query.trim(),
        results,
      };
    },
  };
}
