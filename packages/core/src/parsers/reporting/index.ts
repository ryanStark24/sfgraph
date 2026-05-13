import { parserRegistry } from "../registry.js";
import { DashboardParser } from "./dashboard.js";
import { ReportParser } from "./report.js";

export const reportParser = new ReportParser();
export const dashboardParser = new DashboardParser();
parserRegistry.register(reportParser);
parserRegistry.register(dashboardParser);
export { DashboardParser, ReportParser };
