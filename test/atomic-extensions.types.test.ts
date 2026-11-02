import { expectTypeOf, it } from "vitest";
import {
  type ApiError, type AtomicWriteExtension, type CreateTenantWithOwnerInput,
  type CreateTenantWithOwnerOptions, type KofraContext, type MemberRow,
  type PolicyAdapter, type Principal, type SiteNameMutation, type TenantRow,
  createTenantWithOwner,
} from "@kofra/core";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type Prepare = NonNullable<PolicyAdapter["siteNameMutation"]>;
type Extend = NonNullable<CreateTenantWithOwnerOptions["extend"]>;

// These are compile-time public-boundary assertions. Vitest alone does not typecheck.
it("pins the frozen additive public API, including readonly preparation inputs", () => {
  expectTypeOf<AtomicWriteExtension>().toEqualTypeOf<{
    statements: readonly D1PreparedStatement[];
    mapError?(error: unknown): ApiError | undefined;
  }>();
  expectTypeOf<SiteNameMutation>().toEqualTypeOf<{
    operation: "create" | "rename"; siteId: string; tenantId: string | null;
    slug: string; previousSlug: string | null;
  }>();
  expectTypeOf<Prepare>().toEqualTypeOf<(
    principal: Principal, input: Readonly<SiteNameMutation>, dc: KofraContext,
  ) => AtomicWriteExtension | Promise<AtomicWriteExtension>>();
  expectTypeOf<Equal<Parameters<Prepare>[1], Readonly<SiteNameMutation>>>().toEqualTypeOf<true>();
  expectTypeOf<CreateTenantWithOwnerInput>().toEqualTypeOf<{
    tenant?: { name?: string | null };
    owner: { email?: string | null; name?: string | null; externalRef?: string | null };
  }>();
  expectTypeOf<Extend>().toEqualTypeOf<(
    rows: { tenant: Readonly<TenantRow>; owner: Readonly<MemberRow> }, dc: KofraContext,
  ) => AtomicWriteExtension | Promise<AtomicWriteExtension>>();
  expectTypeOf<Equal<Parameters<Extend>[0]["tenant"], Readonly<TenantRow>>>().toEqualTypeOf<true>();
  expectTypeOf<Equal<Parameters<Extend>[0]["owner"], Readonly<MemberRow>>>().toEqualTypeOf<true>();
  expectTypeOf<typeof createTenantWithOwner>().toEqualTypeOf<(
    dc: KofraContext, input: CreateTenantWithOwnerInput, options?: CreateTenantWithOwnerOptions,
  ) => Promise<{ tenant: TenantRow; owner: MemberRow }>>();
});
