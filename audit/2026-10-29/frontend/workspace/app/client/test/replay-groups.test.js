import assert from "node:assert/strict";
import test from "node:test";
import { REPLAY_GROUPS, replayFilterLabel, replayGroup, replayTeam } from "../src/lib/replayGroups.js";

test("replay group hierarchy exposes team choices only inside their parent group", () => {
  assert.deepEqual(REPLAY_GROUPS.map(group => group.name), ["SNH48", "BEJ48", "GNZ48", "CKG48", "CGT48"]);
  assert.equal(replayGroup("10")?.name, "SNH48");
  assert.equal(replayTeam("10", "sii")?.name, "Team SII");
  assert.equal(replayTeam("11", "sii"), null);
  assert.equal(replayFilterLabel("21", "gii"), "CGT48 · Team GII");
  assert.equal(replayFilterLabel("all", "all"), "全部团体");
});
