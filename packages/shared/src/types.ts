declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type OrgId = Brand<string, "OrgId">;
export type QualifiedName = Brand<string, "QualifiedName">;
export type Sha256 = Brand<string, "Sha256">;

export function asOrgId(s: string): OrgId {
  return s as OrgId;
}
export function asQualifiedName(s: string): QualifiedName {
  return s as QualifiedName;
}
export function asSha256(s: string): Sha256 {
  return s as Sha256;
}
