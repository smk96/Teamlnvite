/// <reference lib="deno.unstable" />

export const kv = await Deno.openKv();

// ==================== Types ====================

export interface Team {
  id: string; // uuid
  name: string;
  accountId: string;
  accessToken: string;
  organizationId?: string;
  email?: string;
  tokenErrorCount: number;
  tokenStatus: "active" | "expired";
  memberCount: number; // Cached count
  lastInviteAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AccessKey {
  code: string; // Primary Key
  teamId?: string; // If bound to a specific team
  isTemp: boolean; // 1-day temp key
  isUnlimited: boolean; // special key can be reused
  tempHours?: number;
  usageCount: number;
  createdAt: number;
}

export interface Invitation {
  id: string; // uuid
  teamId: string;
  email: string;
  keyCode?: string; // The key used
  status: "pending" | "success" | "failed";
  isTemp: boolean;
  tempExpireAt?: number;
  isConfirmed: boolean; // If true, won't be auto-kicked
  createdAt: number;
}

export interface KickLog {
  id: string;
  teamId: string;
  email: string;
  reason: string;
  success: boolean;
  error?: string;
  createdAt: number;
}

export interface AutoKickConfig {
  enabled: boolean;
  checkInterval: number; // seconds
  startHour: number;
  endHour: number;
}

// ==================== Helpers ====================

export const DB = {
  // --- Teams ---
  async createTeam(team: Omit<Team, "id" | "createdAt" | "updatedAt" | "tokenErrorCount" | "tokenStatus" | "memberCount">) {
    const id = crypto.randomUUID();
    const newTeam: Team = {
      ...team,
      id,
      tokenErrorCount: 0,
      tokenStatus: "active",
      memberCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await kv.set(["teams", id], newTeam);
    return newTeam;
  },

  async getTeam(id: string) {
    const res = await kv.get<Team>(["teams", id]);
    return res.value;
  },

  async listTeams() {
    const iter = kv.list<Team>({ prefix: ["teams"] });
    const teams: Team[] = [];
    for await (const res of iter) {
      teams.push(res.value);
    }
    // Sort by createdAt desc
    return teams.sort((a, b) => b.createdAt - a.createdAt);
  },

  async updateTeam(id: string, updates: Partial<Team>) {
    const team = await this.getTeam(id);
    if (!team) throw new Error("Team not found");
    const updatedTeam = { ...team, ...updates, updatedAt: Date.now() };
    await kv.set(["teams", id], updatedTeam);
    return updatedTeam;
  },

  async deleteTeam(id: string) {
    await kv.delete(["teams", id]);
  },

  // --- Access Keys ---
  async createAccessKey(key: Omit<AccessKey, "createdAt" | "usageCount">) {
    const newKey: AccessKey = {
      ...key,
      isUnlimited: key.isUnlimited ?? false,
      usageCount: 0,
      createdAt: Date.now(),
    };
    await kv.set(["keys", key.code], newKey);
    return newKey;
  },

  async getAccessKey(code: string) {
    const res = await kv.get<AccessKey>(["keys", code]);
    return res.value;
  },

  async listAccessKeys() {
    const iter = kv.list<AccessKey>({ prefix: ["keys"] });
    const keys: AccessKey[] = [];
    for await (const res of iter) {
      keys.push(res.value);
    }
    return keys.sort((a, b) => b.createdAt - a.createdAt);
  },

  async deleteAccessKey(code: string) {
    await kv.delete(["keys", code]);
  },

  async incrementKeyUsage(code: string) {
    const key = await this.getAccessKey(code);
    if (key) {
      key.usageCount++;
      await kv.set(["keys", code], key);
    }
  },

  // --- Invitations ---
  async createInvitation(invite: Omit<Invitation, "id" | "createdAt">) {
    const id = crypto.randomUUID();
    const normalizedEmail = invite.email.trim().toLowerCase();
    const newInvite: Invitation = {
      ...invite,
      email: normalizedEmail,
      id,
      createdAt: Date.now(),
    };
    await kv.set(["invitations", id], newInvite);
    // Index by normalized email for quick lookup (auto-kick check)
    await kv.set(["invitations_by_email", normalizedEmail, invite.teamId], id);
    return newInvite;
  },

  async listInvitations() {
    const iter = kv.list<Invitation>({ prefix: ["invitations"] });
    const invites: Invitation[] = [];
    for await (const res of iter) {
      invites.push(res.value);
    }
    return invites.sort((a, b) => b.createdAt - a.createdAt);
  },

  async getInvitationsByEmail(email: string) {
    // This is a bit inefficient without a proper secondary index scan,
    // but for this scale it's okay to scan all invites or use the index we made.
    // The index ["invitations_by_email", email, teamId] -> id
    const normalized = email.trim().toLowerCase();
    const iter = kv.list({ prefix: ["invitations_by_email", normalized] });
    const inviteIds: string[] = [];
    for await (const res of iter) {
      inviteIds.push(res.value as string);
    }
    
    const invites: Invitation[] = [];
    for (const id of inviteIds) {
      const inv = await this.getInvitation(id);
      if (inv) invites.push(inv);
    }
    return invites;
  },

  async getInvitation(id: string) {
    const res = await kv.get<Invitation>(["invitations", id]);
    return res.value;
  },

  async getLatestInvitationByEmail(teamId: string, email: string) {
    const normalized = email.trim().toLowerCase();
    const invites = await this.listInvitations();
    const matches = invites
      .filter((inv) => inv.teamId === teamId && inv.email.trim().toLowerCase() === normalized)
      .sort((a, b) => b.createdAt - a.createdAt);
    return matches[0];
  },

  async updateInvitation(id: string, updates: Partial<Invitation>) {
    const inv = await this.getInvitation(id);
    if (!inv) throw new Error("Invitation not found");
    const updated = { ...inv, ...updates };
    await kv.set(["invitations", id], updated);
    return updated;
  },

  async deleteInvitationsByEmail(teamId: string, email: string) {
    const normalized = email.trim().toLowerCase();
    const invites = await this.listInvitations();
    const matches = invites.filter(
      (inv) => inv.teamId === teamId && inv.email.trim().toLowerCase() === normalized
    );

    for (const inv of matches) {
      await kv.delete(["invitations", inv.id]);
    }
    await kv.delete(["invitations_by_email", normalized, teamId]);

    return matches.length;
  },

  // --- Config ---
  async getAutoKickConfig() {
    const res = await kv.get<AutoKickConfig>(["config", "auto_kick"]);
    return res.value || { enabled: false, checkInterval: 300, startHour: 0, endHour: 23 };
  },

  async setAutoKickConfig(config: AutoKickConfig) {
    await kv.set(["config", "auto_kick"], config);
  },

  // --- Logs ---
  async addKickLog(log: Omit<KickLog, "id" | "createdAt">) {
    const id = crypto.randomUUID();
    const newLog: KickLog = { ...log, id, createdAt: Date.now() };
    await kv.set(["kick_logs", id], newLog);
    return newLog;
  },

  async listKickLogs(limit = 100) {
    const iter = kv.list<KickLog>({ prefix: ["kick_logs"] }, { reverse: true, limit });
    const logs: KickLog[] = [];
    for await (const res of iter) {
      logs.push(res.value);
    }
    return logs;
  }
};
