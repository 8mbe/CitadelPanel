/** Agent endpoints needed to observe, stop, or reactivate a maintained node. */
export function allowedDuringNodeMaintenance(path: string, method = "GET"): boolean {
  const pathname = path.split("?")[0];
  if (pathname === "/v1/maintenance") return method === "POST";
  if (pathname === "/v1/states") return method === "POST";
  if (method === "GET") {
    return pathname === "/v1/health" ||
      pathname === "/v1/database/status" ||
      pathname === "/v1/servers/discovery" ||
      /^\/v1\/backups\/jobs\/[^/]+$/.test(pathname ?? "") ||
      /^\/v1\/servers\/[^/]+\/(state|logs|install\/logs)$/.test(pathname ?? "");
  }
  return method === "POST" && (
    pathname === "/v1/database/stop" ||
    /^\/v1\/servers\/[^/]+\/(stop|kill)$/.test(pathname ?? "")
  );
}
