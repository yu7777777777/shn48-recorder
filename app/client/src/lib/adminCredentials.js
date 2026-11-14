export function validateAdminCredentials(form) {
  const errors = {};
  const username = form.newUsername.trim();

  if (!form.currentPassword) errors.currentPassword = "请输入当前管理员密码";
  if (!username) errors.newUsername = "请输入新的管理员账号";
  else if (username.length < 3) errors.newUsername = "管理员账号至少需要 3 个字符";
  else if (username.length > 64) errors.newUsername = "管理员账号不能超过 64 个字符";
  else if (/\s/.test(username)) errors.newUsername = "管理员账号不能包含空格";
  if (!form.newPassword) errors.newPassword = "请输入新密码";
  else if (form.newPassword.length < 10) errors.newPassword = "新密码至少需要 10 个字符";
  else if (form.newPassword.length > 256) errors.newPassword = "新密码不能超过 256 个字符";
  else if (form.newPassword === form.currentPassword) errors.newPassword = "新密码不能与当前密码相同";
  else if (form.newPassword === username) errors.newPassword = "新密码不能与管理员账号相同";
  else if ([/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(form.newPassword)).length < 2) errors.newPassword = "新密码需要包含小写字母、大写字母、数字或符号中的至少两类";
  if (!form.confirmPassword) errors.confirmPassword = "请再次输入新密码";
  else if (form.confirmPassword !== form.newPassword) errors.confirmPassword = "两次输入的新密码不一致";

  return errors;
}

export function passwordStrength(password) {
  if (!password) return { score: 0, label: "等待输入" };
  let score = password.length >= 8 ? 1 : 0;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  const labels = ["较弱", "较弱", "一般", "良好", "较强"];
  return { score, label: labels[score] };
}
