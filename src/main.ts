function renderRoomScreen(): void {
  const app = document.getElementById("app");
  if (!app) return;

  app.innerHTML = "";

  const title = document.createElement("h1");
  title.textContent = "VTT — Sala";

  const hostButton = document.createElement("button");
  hostButton.textContent = "Hospedar sala";
  hostButton.addEventListener("click", () => {
    console.log("host room");
  });

  const joinButton = document.createElement("button");
  joinButton.textContent = "Entrar em sala";
  joinButton.addEventListener("click", () => {
    console.log("join room");
  });

  app.append(title, hostButton, joinButton);
}

renderRoomScreen();
