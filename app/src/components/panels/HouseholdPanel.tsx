"use client";

// HouseholdPanel — membership lifecycle: create the household, onboard members,
// remove members, and re-assign roles.
//
// Four instructions, three of them Owner-only:
//
//   - `initialize_household` : any connected wallet becomes the owner of a
//     freshly-created household + vault + owner membership. The ONLY
//     instruction that does NOT need a pre-existing household (it creates one),
//     so its sub-panel runs with `requireHousehold={false}` on its own gate.
//   - `add_member`            : Owner-only. Onboards a wallet under a chosen
//     role (Parent/Child/Guest — `Owner` is rejected by the program).
//   - `remove_member`         : Owner-only. Closes a membership PDA and
//     refunds rent to the owner. The household owner is irremovable.
//   - `set_role`              : Owner-only. Changes a member's role. Promotion
//     to `Owner` is rejected by the program.
//
// Every "manage members" instruction takes a target wallet as an instruction
// ARG (not an account), which seeds the target's `Member` PDA. The frontend
// derives that PDA client-side (`memberPda(household, targetWallet)`) and
// passes it explicitly via `.accountsStrict({...})`.

import { useMemo, useState } from "react";
import { useProgram } from "@/lib/program";
import { useHouseholdContext } from "@/hooks/useHouseholdContext";
import { useTransactionWithRefresh as useTransaction } from "@/hooks/useRefresh";
import { SYSTEM_PROGRAM_ID, householdPda, memberPda } from "@/lib/accounts";
import { toHash32 } from "@/lib/hashes";
import { tryParsePublicKey } from "@/lib/parse";
import { roleToAnchor, type Role } from "@/lib/types";
import { Panel, SubPanel } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { ResultBanner } from "@/components/ui/ResultBanner";
import { ConnectGate } from "@/components/ui/ConnectGate";

// `add_member` / `set_role` deliberately exclude `owner` from the selectable
// variants: the program rejects `Role::Owner` (a household has exactly one
// owner, set exclusively by `initialize_household`). We surface the option as
// a disabled row so the constraint is self-documenting in the UI.
const ROLE_OPTIONS: SelectOption[] = [
  { value: "parent", label: "Parent" },
  { value: "child", label: "Child" },
  { value: "guest", label: "Guest" },
  { value: "owner", label: "Owner (not allowed)", disabled: true },
];

export function HouseholdPanel() {
  return (
    <Panel
      title="Household"
      description="Create a household (you become the owner) and manage its membership. Adding, removing, and role changes are owner-only — connect the household owner wallet to use them."
    >
      <ConnectGate requireHousehold={false}>
        <InitializeForm />
        <ManageMembersSection />
      </ConnectGate>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// initialize_household
// ---------------------------------------------------------------------------

function InitializeForm() {
  const program = useProgram();
  // initialize_household creates the household from the connected wallet, so
  // it does NOT consume the context's resolved household (which is derived
  // from the owner field and would be null/empty before init). We only need
  // the connected wallet here.
  const { connectedWallet, isConnected } = useHouseholdContext();
  const tx = useTransaction();
  const [name, setName] = useState("");

  const canSubmit =
    isConnected &&
    !!program &&
    !!connectedWallet &&
    name.trim().length > 0 &&
    !tx.pending;

  const handleSubmit = () => {
    if (!program || !connectedWallet || name.trim().length === 0) return;
    const owner = connectedWallet;
    const household = householdPda(owner);
    const ownerMember = memberPda(household, owner);
    void tx.submit(async () => {
      // name_hash is a blake3 digest of the off-chain display name. The
      // program stores only the hash (privacy-preserving); the raw name never
      // touches the ledger.
      const nameHash = toHash32(name);
      return program.methods
        .initializeHousehold(nameHash)
        .accountsStrict({
          household,
          ownerMember,
          owner,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc();
    });
  };

  return (
    <SubPanel
      label="initialize_household"
      hint="Create a new household + vault + your owner membership in one transaction. You become the household owner; the name is blake3-hashed before submission."
    >
      <Field
        label="Household name"
        value={name}
        onChange={setName}
        placeholder="e.g. The Smiths"
        helpText="Blake3-hashed client-side; only the 32-byte digest is stored on-chain."
        onSubmit={handleSubmit}
      />
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
        >
          Initialize Household
        </Button>
      </div>
      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
    </SubPanel>
  );
}

// ---------------------------------------------------------------------------
// add_member / remove_member / set_role (all Owner-only)
// ---------------------------------------------------------------------------

function ManageMembersSection() {
  const { isOwnerConnected } = useHouseholdContext();

  // Owner-only gate, shared by all three instructions. Surface it once at the
  // section level rather than per-form so the user understands the whole
  // section is locked.
  if (!isOwnerConnected) {
    return (
      <SubPanel
        label="Membership management"
        hint="Owner-only. Connect the household owner wallet (or set the owner field above to your wallet) to add/remove members and change roles."
      >
        <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-3 text-xs text-slate-400">
          The connected wallet is not the resolved household owner. Membership
          management is restricted to the owner.
        </p>
      </SubPanel>
    );
  }

  return (
    <>
      <AddMemberForm />
      <RemoveMemberForm />
      <SetRoleForm />
    </>
  );
}

function AddMemberForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember } = useHouseholdContext();
  const tx = useTransaction();
  const [walletInput, setWalletInput] = useState("");
  const [role, setRole] = useState<string>("");

  const targetWallet = useMemo(
    () => tryParsePublicKey(walletInput),
    [walletInput]
  );

  const walletError = useMemo(() => {
    if (walletInput.trim().length === 0) return null;
    return targetWallet ? null : "Invalid Solana address";
  }, [walletInput, targetWallet]);

  const roleError = role === "" ? "Select a role" : null;

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    !!targetWallet &&
    !walletError &&
    role !== "" &&
    role !== "owner" &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      !targetWallet
    )
      return;
    if (role === "" || role === "owner") return;
    const newMember = memberPda(household, targetWallet);
    const selectedRole = role as Role;
    void tx.submit(async () => {
      // add_member(new_member_wallet, role): positional args are the target
      // wallet pubkey followed by the Role enum. `.accountsStrict` carries the
      // household, the caller's Member PDA, the seed-derived new Member PDA,
      // the caller signer, and the system program (rent for the new PDA).
      return program.methods
        .addMember(targetWallet, roleToAnchor(selectedRole))
        .accountsStrict({
          household,
          callerMember,
          newMember,
          caller: connectedWallet,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc();
    });
  };

  return (
    <SubPanel
      label="add_member"
      hint="Owner-only. Onboard a wallet under a role. The role is permanent until changed with set_role; the owner role is never assignable here."
    >
      <Field
        label="New member wallet"
        value={walletInput}
        onChange={setWalletInput}
        placeholder="Base58 address"
        mono
        error={walletError}
        onSubmit={handleSubmit}
        helpText="The wallet being added — they need not be connected or be a signer."
      />
      <Select
        label="Role"
        value={role}
        onChange={setRole}
        options={ROLE_OPTIONS}
        placeholder="Pick a role"
        error={roleError}
        onSubmit={handleSubmit}
      />
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
        >
          Add Member
        </Button>
      </div>
      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
    </SubPanel>
  );
}

function RemoveMemberForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember } = useHouseholdContext();
  const tx = useTransaction();
  const [walletInput, setWalletInput] = useState("");

  const targetWallet = useMemo(
    () => tryParsePublicKey(walletInput),
    [walletInput]
  );

  const walletError = useMemo(() => {
    if (walletInput.trim().length === 0) return null;
    return targetWallet ? null : "Invalid Solana address";
  }, [walletInput, targetWallet]);

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    !!targetWallet &&
    !walletError &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      !targetWallet
    )
      return;
    const targetMember = memberPda(household, targetWallet);
    void tx.submit(async () => {
      // remove_member(member_wallet): closes the target Member PDA and refunds
      // rent to the caller (owner). The household owner is irremovable — the
      // program rejects it with CannotModifyOwner.
      return program.methods
        .removeMember(targetWallet)
        .accountsStrict({
          household,
          callerMember,
          targetMember,
          caller: connectedWallet,
        })
        .rpc();
    });
  };

  return (
    <SubPanel
      label="remove_member"
      hint="Owner-only. Closes the membership PDA and refunds rent to the owner. The household owner cannot be removed. Re-adding a removed wallet works via add_member."
    >
      <Field
        label="Member wallet to remove"
        value={walletInput}
        onChange={setWalletInput}
        placeholder="Base58 address"
        mono
        error={walletError}
        onSubmit={handleSubmit}
      />
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
          variant="danger"
        >
          Remove Member
        </Button>
      </div>
      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
    </SubPanel>
  );
}

function SetRoleForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember } = useHouseholdContext();
  const tx = useTransaction();
  const [walletInput, setWalletInput] = useState("");
  const [newRole, setNewRole] = useState<string>("");

  const targetWallet = useMemo(
    () => tryParsePublicKey(walletInput),
    [walletInput]
  );

  const walletError = useMemo(() => {
    if (walletInput.trim().length === 0) return null;
    return targetWallet ? null : "Invalid Solana address";
  }, [walletInput, targetWallet]);

  const roleError = newRole === "" ? "Select a role" : null;

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    !!targetWallet &&
    !walletError &&
    newRole !== "" &&
    newRole !== "owner" &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      !targetWallet
    )
      return;
    if (newRole === "" || newRole === "owner") return;
    const targetMember = memberPda(household, targetWallet);
    const selectedRole = newRole as Role;
    void tx.submit(async () => {
      // set_role(new_role, member_wallet): NOTE the arg order — role first,
      // then wallet. This matches the on-chain handler signature.
      return program.methods
        .setRole(roleToAnchor(selectedRole), targetWallet)
        .accountsStrict({
          household,
          callerMember,
          targetMember,
          caller: connectedWallet,
        })
        .rpc();
    });
  };

  return (
    <SubPanel
      label="set_role"
      hint="Owner-only. Change a member's role. Promotion to owner is rejected — the only owner is the household creator."
    >
      <Field
        label="Member wallet"
        value={walletInput}
        onChange={setWalletInput}
        placeholder="Base58 address"
        mono
        error={walletError}
        onSubmit={handleSubmit}
      />
      <Select
        label="New role"
        value={newRole}
        onChange={setNewRole}
        options={ROLE_OPTIONS}
        placeholder="Pick a role"
        error={roleError}
        onSubmit={handleSubmit}
      />
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
        >
          Update Role
        </Button>
      </div>
      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
    </SubPanel>
  );
}
