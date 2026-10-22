const $ = (s) => document.querySelector(s);
let handlers = {},
  token = null,
  mode = "forgot",
  busy = false;
export function accountHandlers(value) {
  handlers = value;
}
async function request(path, data = {}) {
  const response = await fetch("/api/auth/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ViceClipz": "studio" },
    body: JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Não foi possível concluir.");
  return value;
}
const screen = document.createElement("section");
screen.id = "verification-screen";
screen.className = "account-screen";
screen.hidden = true;
screen.innerHTML =
  '<div class="account-box"><a class="brand" href="/">viceclipz ✦</a><p class="eyebrow">SÓ MAIS UM PASSO</p><h1>Confirme seu e-mail.</h1><p>Enviaremos um link para <strong id="verification-email"></strong>. Abra a mensagem e confirme para acessar seu estúdio.</p><p class="field-help">O link vale por 24 horas. Confira também o spam. Você precisará entrar novamente após confirmar.</p><p id="verification-status" role="status"></p><div class="account-actions"><button id="verification-resend" class="primary">Enviar novo link</button><button id="verification-check" class="secondary">Já confirmei meu e-mail</button><button id="verification-logout" class="text-button">Sair / usar outra conta</button></div></div>';
document.body.append(screen);
export function hideVerification() {
  screen.hidden = true;
  $("#verification-email").textContent = "";
  $("#verification-status").textContent = "";
}
export function showVerification(session) {
  $("#app").hidden = true;
  $("#auth-screen").hidden = true;
  screen.hidden = false;
  $("#verification-email").textContent = session.user.email;
  $("#verification-status").textContent = session.verification.emailConfigured
    ? "Solicite outro link se o anterior não chegou ou expirou."
    : "O envio de e-mail está indisponível. Tente novamente mais tarde.";
  $("#verification-resend").disabled = !session.verification.emailConfigured;
}
$("#verification-resend").onclick = async () => {
  const button = $("#verification-resend");
  button.disabled = true;
  try {
    $("#verification-status").textContent = (
      await request("verification/resend")
    ).message;
  } catch (e) {
    $("#verification-status").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("#verification-check").onclick = () => handlers.reload?.();
$("#verification-logout").onclick = async () => {
  try {
    await request("logout");
    handlers.signedOut?.();
  } catch (e) {
    $("#verification-status").textContent = e.message;
  }
};
const forgot = document.createElement("button");
forgot.id = "forgot-password";
forgot.className = "text-button";
forgot.type = "button";
forgot.textContent = "Esqueci minha senha";
$("#auth-toggle").after(forgot);
const dialog = document.createElement("dialog");
dialog.id = "account-dialog";
dialog.innerHTML =
  '<form id="account-form" class="account-box"><div class="account-title"><h2 id="account-title"></h2><button type="button" id="account-close" class="secondary">Fechar</button></div><p id="account-copy"></p><label id="account-email-label">E-mail<input id="account-email" type="email" maxlength="254" autocomplete="email"></label><label id="account-password-label">Nova senha<input id="account-password" type="password" minlength="10" maxlength="128" autocomplete="new-password"></label><label id="account-confirm-label">Confirme a nova senha<input id="account-confirm" type="password" minlength="10" maxlength="128" autocomplete="new-password"></label><p id="account-result" role="status"></p><button class="primary" id="account-submit"></button></form>';
document.body.append(dialog);
function open(value) {
  $("#account-submit").hidden = false;
  mode = value;
  $("#account-form").reset();
  $("#account-result").textContent = "";
  $("#account-email-label").hidden = mode !== "forgot";
  $("#account-email").required = mode === "forgot";
  $("#account-password-label").hidden = $("#account-confirm-label").hidden =
    mode !== "reset";
  $("#account-password").required = $("#account-confirm").required =
    mode === "reset";
  $("#account-submit").disabled = false;
  $("#account-title").textContent = {
    forgot: "Recuperar acesso",
    reset: "Crie uma nova senha",
    verify: "Confirmar e-mail",
  }[mode];
  $("#account-copy").textContent = {
    forgot:
      "Informe o e-mail da sua conta. Se ela existir, enviaremos um link válido por 30 minutos.",
    reset:
      "Use entre 10 e 128 caracteres. Todas as sessões da sua conta serão encerradas.",
    verify:
      "Confirme abaixo para validar seu e-mail. O link é de uso único e você precisará entrar novamente.",
  }[mode];
  $("#account-submit").textContent = {
    forgot: "Enviar link de recuperação",
    reset: "Salvar nova senha",
    verify: "Confirmar meu e-mail",
  }[mode];
  if (!dialog.open) dialog.showModal();
}
forgot.onclick = () => {
  token = null;
  open("forgot");
  $("#account-email").value = $("#auth-email").value;
};
$("#account-close").onclick = () => {
  if (!busy) dialog.close();
};
dialog.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
dialog.addEventListener("close", () => {
  token = null;
  $("#account-password").value = $("#account-confirm").value = "";
});
$("#account-form").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  const button = $("#account-submit");
  busy = true;
  button.disabled = true;
  $("#account-result").textContent = "";
  try {
    if (
      mode === "reset" &&
      $("#account-password").value !== $("#account-confirm").value
    )
      throw Error("As senhas precisam ser iguais.");
    const result = await request(
      {
        forgot: "forgot-password",
        reset: "reset-password",
        verify: "verify-email",
      }[mode],
      mode === "forgot"
        ? { email: $("#account-email").value }
        : {
            token,
            ...(mode === "reset"
              ? { password: $("#account-password").value }
              : {}),
          },
    );
    $("#account-result").textContent = result.message;
    if (mode !== "forgot") {
      token = null;
      $("#account-password").value = $("#account-confirm").value = "";
      handlers.signedOut?.();
      $("#account-submit").hidden = true;
    } else button.disabled = false;
  } catch (e) {
    $("#account-result").textContent = e.message;
    button.disabled = false;
  } finally {
    busy = false;
  }
};
function readLink() {
  const match = /^#(verify-email|reset-password)\?(.*)$/.exec(location.hash);
  if (!match) return;
  token = new URLSearchParams(match[2]).get("token");
  history.replaceState(
    null,
    "",
    location.pathname + location.search + "#overview",
  );
  open(match[1] === "verify-email" ? "verify" : "reset");
  $("#account-submit").hidden = false;
  if (!/^[a-f0-9]{64}$/.test(token || "")) {
    $("#account-result").textContent = "Link inválido. Solicite um novo link.";
    $("#account-submit").disabled = true;
  }
}
window.addEventListener("hashchange", readLink);
readLink();
