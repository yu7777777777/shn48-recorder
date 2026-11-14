import assert from "node:assert/strict";
import test from "node:test";
import { passwordStrength, validateAdminCredentials } from "../src/lib/adminCredentials.js";

test("admin credential form rejects incomplete and inconsistent values", () => {
  const errors = validateAdminCredentials({
    currentPassword: "current-pass",
    newUsername: "admin account",
    newPassword: "short",
    confirmPassword: "different",
  });

  assert.match(errors.newUsername, /空格/);
  assert.match(errors.newPassword, /10/);
  assert.match(errors.confirmPassword, /不一致/);
});

test("admin credential form accepts a valid password change", () => {
  const errors = validateAdminCredentials({
    currentPassword: "current-pass",
    newUsername: "admin-next",
    newPassword: "Stronger-pass-2026",
    confirmPassword: "Stronger-pass-2026",
  });

  assert.deepEqual(errors, {});
  assert.deepEqual(passwordStrength("Stronger-pass-2026"), { score: 4, label: "较强" });
});

test("lowercase and uppercase letters count as two password character types", () => {
  const errors = validateAdminCredentials({
    currentPassword: "previous-pass-2026",
    newUsername: "admin-next",
    newPassword: "OnlyLetters",
    confirmPassword: "OnlyLetters",
  });

  assert.deepEqual(errors, {});
});
