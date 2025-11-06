// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more about it at https://v2.hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const UsmModule = buildModule("UsmModule", (m) => {
  const usm = m.contract("Usm");
  return { usm };
});

export default UsmModule;
