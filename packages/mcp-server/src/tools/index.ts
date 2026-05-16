// Side-effect imports — each module registers its tool on the default registry.
import "./ping.js";
import "./start_ingest_job.js";
import "./get_ingest_job.js";
import "./snapshot_create.js";
import "./snapshot_list.js";
import "./point_in_time_diff.js";
import "./what_broke.js";
import "./freshness_report.js";
import "./analyze_field.js";
import "./impact_from_git_diff.js";
import "./test_gap_intelligence_from_git_diff.js";
import "./cross_layer_flow_map.js";
import "./trace_upstream.js";
import "./trace_downstream.js";
import "./cross_org_diff.js";
import "./governor_risk_check.js";
import "./dead_code_audit.js";
import "./security_audit.js";
import "./deployment_manifest_gen.js";
import "./wip_impact.js";
import "./wip_diff.js";
import "./wip_test_gap.js";
import "./list_orgs.js";
import "./staleness_check.js";
import "./explain_code.js";
import "./find_similar.js";

export { defaultRegistry } from "../tool-registry.js";
