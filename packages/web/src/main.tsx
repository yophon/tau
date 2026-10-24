// tau's web client (P59): served by the resident server (tau serve remote on), opened on a phone.
import { render } from "preact";
import { App } from "./app.tsx";
import "./styles.css";

const root = document.getElementById("app");
if (root) render(<App />, root);
