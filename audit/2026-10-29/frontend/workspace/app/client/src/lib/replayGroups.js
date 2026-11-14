export const REPLAY_GROUPS = Object.freeze([
  {
    id: "10",
    name: "SNH48",
    teams: [
      { id: "sii", name: "Team SII" },
      { id: "nii", name: "Team NII" },
      { id: "hii", name: "Team HII" },
      { id: "x", name: "Team X" },
      { id: "trainee", name: "预备生" },
    ],
  },
  {
    id: "11",
    name: "BEJ48",
    teams: [
      { id: "b", name: "Team B" },
      { id: "e", name: "Team E" },
      { id: "trainee", name: "预备生" },
    ],
  },
  {
    id: "12",
    name: "GNZ48",
    teams: [
      { id: "g", name: "Team G" },
      { id: "niii", name: "Team NIII" },
      { id: "z", name: "Team Z" },
      { id: "trainee", name: "预备生" },
    ],
  },
  {
    id: "14",
    name: "CKG48",
    teams: [
      { id: "c", name: "Team C" },
      { id: "k", name: "Team K" },
      { id: "trainee", name: "预备生" },
    ],
  },
  {
    id: "21",
    name: "CGT48",
    teams: [
      { id: "cii", name: "Team CII" },
      { id: "gii", name: "Team GII" },
      { id: "trainee", name: "预备生" },
    ],
  },
]);

export function replayGroup(groupId) {
  return REPLAY_GROUPS.find(group => group.id === String(groupId)) || null;
}

export function replayTeam(groupId, teamId) {
  return replayGroup(groupId)?.teams.find(team => team.id === String(teamId)) || null;
}

export function replayFilterLabel(groupId, teamId) {
  const group = replayGroup(groupId);
  if (!group) return "全部团体";
  const team = replayTeam(groupId, teamId);
  return team ? `${group.name} · ${team.name}` : group.name;
}
