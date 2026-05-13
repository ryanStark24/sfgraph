export interface ToolResponse<TData = unknown> {
  summary: string;
  markdown: string;
  data: TData;
  follow_up_tools?: string[];
}
