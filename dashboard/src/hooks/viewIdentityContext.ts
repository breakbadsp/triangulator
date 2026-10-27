import { createContext } from "react";
/**
 * Which view the page shows: `key` changes with the observation (target,
 * session, recorded time), and Help, held values, and readouts use it to drop
 * state that belongs to the previous view. It carries no observation data.
 */
export const ViewIdentityContext = createContext({
  key: "",
  recorded: false,
});
