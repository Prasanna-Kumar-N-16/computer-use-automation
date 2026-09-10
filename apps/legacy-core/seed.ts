/**
 * Seed data for the MeridianCore Servicing mock.
 *
 * Member numbers are chosen so that each one exercises a distinct branch of the
 * replay error taxonomy. See the table in README.md.
 */

export type AccountKind = "Savings" | "Checking" | "Share Certificate" | "Money Market";

export interface Account {
  number: string;
  kind: AccountKind;
  status: "Open" | "Closed" | "Frozen";
  balance: number;
  openedOn: string;
}

export interface Member {
  memberNumber: string;
  name: string;
  branch: string;
  joinedOn: string;
  accounts: Account[];
}

/** How the app should behave for a given member number, beyond the happy path. */
export type MemberBehaviour =
  | "ok"
  | "not_found"
  | "permission_denied"
  | "interstitial"
  | "app_error";

export const BEHAVIOUR: Record<string, MemberBehaviour> = {
  "12345": "ok",
  "24680": "ok",
  "31415": "ok",
  "55555": "interstitial",
  "70001": "permission_denied",
  "50000": "app_error",
};

export function behaviourFor(memberNumber: string): MemberBehaviour {
  return BEHAVIOUR[memberNumber] ?? "not_found";
}

export const MEMBERS: Record<string, Member> = {
  "12345": {
    memberNumber: "12345",
    name: "Dolores Ferrante",
    branch: "Riverbend",
    joinedOn: "03/14/2009",
    accounts: [
      { number: "0001284471", kind: "Savings", status: "Open", balance: 4182.55, openedOn: "03/14/2009" },
      { number: "0001284472", kind: "Checking", status: "Open", balance: 1290.03, openedOn: "03/14/2009" },
      { number: "0001991002", kind: "Share Certificate", status: "Open", balance: 15000.0, openedOn: "07/01/2021" },
    ],
  },
  "24680": {
    memberNumber: "24680",
    name: "Marcus Whitfield",
    branch: "Northgate",
    joinedOn: "11/02/2016",
    accounts: [
      { number: "0002771830", kind: "Savings", status: "Open", balance: 812.4, openedOn: "11/02/2016" },
      { number: "0002771831", kind: "Money Market", status: "Frozen", balance: 22040.18, openedOn: "01/09/2020" },
    ],
  },
  "31415": {
    memberNumber: "31415",
    name: "Aurelia Nakamura-Boyd",
    branch: "Riverbend",
    joinedOn: "06/21/2004",
    accounts: [
      { number: "0000451190", kind: "Savings", status: "Open", balance: 63.19, openedOn: "06/21/2004" },
    ],
  },
  "55555": {
    memberNumber: "55555",
    name: "Theodore Vasquez",
    branch: "Southport",
    joinedOn: "02/28/2019",
    accounts: [
      { number: "0003340019", kind: "Savings", status: "Open", balance: 9905.77, openedOn: "02/28/2019" },
    ],
  },
  "70001": {
    memberNumber: "70001",
    name: "RESTRICTED",
    branch: "—",
    joinedOn: "—",
    accounts: [],
  },
  "50000": {
    memberNumber: "50000",
    name: "CORRUPT RECORD",
    branch: "—",
    joinedOn: "—",
    accounts: [],
  },
};

export const SUB_ACCOUNT_PRODUCTS = [
  { code: "SAV-02", label: "Regular Savings" },
  { code: "SAV-07", label: "Holiday Club Savings" },
  { code: "MMK-01", label: "Premier Money Market" },
];

export const APP_NAME = "MeridianCore Servicing";
export const APP_VERSION = "7.2.1";
