import { parserRegistry } from "../registry.js";
import { PermissionSetParser } from "./permission-set.js";
import { ProfileParser } from "./profile.js";
import { SharingRulesParser } from "./sharing-rule.js";

export const profileParser = new ProfileParser();
export const permissionSetParser = new PermissionSetParser();
export const sharingRulesParser = new SharingRulesParser();

parserRegistry.register(profileParser);
parserRegistry.register(permissionSetParser);
parserRegistry.register(sharingRulesParser);

export { PermissionSetParser, ProfileParser, SharingRulesParser };
