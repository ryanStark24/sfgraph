import { parserRegistry } from "../registry.js";
import { ExternalServiceRegistrationParser } from "./external-service-registration.js";
import { NamedCredentialParser } from "./named-credential.js";
import { PlatformEventParser } from "./platform-event.js";

export const namedCredentialParser = new NamedCredentialParser();
export const externalServiceRegistrationParser = new ExternalServiceRegistrationParser();
export const platformEventParser = new PlatformEventParser();

parserRegistry.register(namedCredentialParser);
parserRegistry.register(externalServiceRegistrationParser);
parserRegistry.register(platformEventParser);

export { ExternalServiceRegistrationParser, NamedCredentialParser, PlatformEventParser };
