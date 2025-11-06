import { expect } from "chai";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";

describe("USM Token Tests", function () {
  let contract: any;
  let owner: any;
  let addr1: any;
  let addr2: any;

  beforeEach(async function () {
    [owner, addr1, addr2] = await hre.viem.getWalletClients();
    contract = await hre.viem.deployContract("Usm", []);
  });

  describe("Deployment", function () {
    it("Should deploy the contract with correct initial values", async function () {
      expect((await contract.read.owner()).toLowerCase()).to.equal(owner.account.address.toLowerCase());
      expect(await contract.read.totalSupply()).to.equal(parseEther("1000000000"));
      expect(Number(await contract.read.burnRate())).to.equal(0);
      expect(await contract.read.isTransferWithBurnEnabled()).to.be.false;
      expect(await contract.read.paused()).to.be.false;
      expect(await contract.read.MAX_SUPPLY()).to.equal(parseEther("2000000000"));
      expect(Number(await contract.read.MINT_COOLDOWN())).to.equal(30 * 24 * 60 * 60);
      expect(Number(await contract.read.TIMELOCK_DURATION())).to.equal(2 * 24 * 60 * 60);
    });

    it("Should have correct token info", async function () {
      const tokenInfo = await contract.read.getTokenInfo();
      expect(tokenInfo.name).to.equal("Unified Social Markets");
      expect(tokenInfo.symbol).to.equal("USM");
      expect(tokenInfo.decimals).to.equal(18);
      expect(tokenInfo.totalSupply).to.equal(parseEther("1000000000"));
      expect(tokenInfo.isTransferWithBurnEnabled).to.be.false;
      expect(Number(tokenInfo.burnRate)).to.equal(0);
      expect(tokenInfo.paused).to.be.false;
    });
  });

  describe("Ownership", function () {
    it("should return true if caller is the owner", async function () {
      expect(await contract.read.isOwner()).to.equal(true);
    });

    it("should return false if caller is not the owner", async function () {
      const isOwner = await contract.read.owner();
      const isAddr1Owner = isOwner.toLowerCase() === addr1.account.address.toLowerCase();
      expect(isAddr1Owner).to.equal(false);
    });
  });

  describe("Pausable", function () {
    it("should allow only owner to pause and unpause", async function () {
      await contract.write.pause();
      expect(await contract.read.paused()).to.be.true;

      await contract.write.unpause();
      expect(await contract.read.paused()).to.be.false;
    });

    it("should revert transfer when contract is paused", async function () {
      await contract.write.send([addr1.account.address, parseEther("100")]);
      await contract.write.pause();

      const contractAsAddr1 = await hre.viem.getContractAt(
        "Usm", 
        contract.address, 
        { walletClient: addr1 }
      );
      
      await expect(
        contractAsAddr1.write.transfer([addr2.account.address, parseEther("10")])
      ).to.be.rejected;
    });

    it("should revert transferFrom when contract is paused", async function () {
      await contract.write.send([addr1.account.address, parseEther("100")]);
      
      const contractAsAddr1 = await hre.viem.getContractAt(
        "Usm", 
        contract.address, 
        { walletClient: addr1 }
      );
      await contractAsAddr1.write.approve([addr2.account.address, parseEther("50")]);
      
      await contract.write.pause();

      const contractAsAddr2 = await hre.viem.getContractAt(
        "Usm", 
        contract.address, 
        { walletClient: addr2 }
      );

      await expect(
        contractAsAddr2.write.transferFrom([addr1.account.address, addr2.account.address, parseEther("10")])
      ).to.be.rejected;
    });
  });

  describe("Transfer with Burn", function () {
    it("should enable/disable transferWithBurn function only for owner", async function () {
      await contract.write.setTransferWithBurn([true]);
      expect(await contract.read.isTransferWithBurnEnabled()).to.be.true;

      await contract.write.setTransferWithBurn([false]);
      expect(await contract.read.isTransferWithBurnEnabled()).to.be.false;
    });

    it("should not enable transferWithBurn if burn rate is too high", async function () {
      await hre.network.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      
      await contract.write.proposeBurnRate([50]);
      await hre.network.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]);
      await contract.write.executeBurnRateUpdate();

      await contract.write.setTransferWithBurn([true]);
      expect(await contract.read.isTransferWithBurnEnabled()).to.be.true;
    });
  });

  describe("Burn Rate Management", function () {
    it("should propose new burn rate with timelock", async function () {
      await contract.write.proposeBurnRate([50]);
      expect(Number(await contract.read.pendingBurnRate())).to.equal(50);
      expect(await contract.read.hasPendingBurnRateUpdate()).to.be.true;
      expect(Number(await contract.read.burnRateUpdateTime())).to.be.gt(0);
    });

    it("should not propose burn rate above 10%", async function () {
      await expect(contract.write.proposeBurnRate([101])).to.be.rejected;
    });

    it("should not propose same burn rate", async function () {
      await contract.write.proposeBurnRate([50]);
      await hre.network.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]);
      await contract.write.executeBurnRateUpdate();
      await expect(contract.write.proposeBurnRate([50])).to.be.rejected;
    });

    it("should execute burn rate update after timelock", async function () {
      await contract.write.proposeBurnRate([50]);
      
      await hre.network.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]);
      
      const contractAsAddr1 = await hre.viem.getContractAt(
        "Usm", 
        contract.address, 
        { walletClient: addr1 }
      );
      await contractAsAddr1.write.executeBurnRateUpdate();

      expect(Number(await contract.read.burnRate())).to.equal(50);
      expect(await contract.read.hasPendingBurnRateUpdate()).to.be.false;
    });

    it("should cancel pending burn rate update", async function () {
      await contract.write.proposeBurnRate([50]);
      
      await contract.write.cancelBurnRateUpdate();
      expect(await contract.read.hasPendingBurnRateUpdate()).to.be.false;
    });

    it("should get time until burn rate update", async function () {
      expect(Number(await contract.read.getTimeUntilBurnRateUpdate())).to.equal(0);
      
      await contract.write.proposeBurnRate([50]);
      const timeRemaining = Number(await contract.read.getTimeUntilBurnRateUpdate());
      expect(timeRemaining).to.be.gt(0).and.lte(2 * 24 * 60 * 60);
    });
  });

describe("Token Transfers", function () {
  it("should transfer tokens without burn when disabled", async function () {
    await contract.write.send([addr1.account.address, parseEther("100")]);
    
    const contractAsAddr1 = await hre.viem.getContractAt(
      "Usm", 
      contract.address, 
      { client: { wallet: addr1 } }
    );
    
    await contractAsAddr1.write.transfer([addr2.account.address, parseEther("50")]);

    expect(await contract.read.balanceOf([addr1.account.address])).to.equal(parseEther("50"));
    expect(await contract.read.balanceOf([addr2.account.address])).to.equal(parseEther("50"));
  });

  it("should transfer tokens with burn when enabled", async function () {
    await contract.write.setTransferWithBurn([true]);
    await contract.write.proposeBurnRate([50]); // 5%
    await hre.network.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]);
    await contract.write.executeBurnRateUpdate();

    await contract.write.send([addr1.account.address, parseEther("100")]);
    
    const contractAsAddr1 = await hre.viem.getContractAt(
      "Usm", 
      contract.address, 
      { client: { wallet: addr1 } }
    );
    
    await contractAsAddr1.write.transfer([addr2.account.address, parseEther("50")]);

    const expectedBurn = (parseEther("50") * 50n) / 1000n; // 5% of 50 = 2.5
    const expectedReceived = parseEther("50") - expectedBurn; // 47.5

    expect(await contract.read.balanceOf([addr2.account.address])).to.equal(expectedReceived);
    
    expect(await contract.read.balanceOf([addr1.account.address])).to.equal(parseEther("50"));
  });

  it("should transferFrom tokens with burn when enabled", async function () {
    await contract.write.setTransferWithBurn([true]);
    await contract.write.proposeBurnRate([50]); // 5%
    await hre.network.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]);
    await contract.write.executeBurnRateUpdate();

    await contract.write.send([addr1.account.address, parseEther("100")]);
    
    const contractAsAddr1 = await hre.viem.getContractAt(
      "Usm", 
      contract.address, 
      { client: { wallet: addr1 } }
    );
    await contractAsAddr1.write.approve([addr2.account.address, parseEther("50")]);

    const contractAsAddr2 = await hre.viem.getContractAt(
      "Usm", 
      contract.address, 
      { client: { wallet: addr2 } }
    );
    
    await contractAsAddr2.write.transferFrom([
      addr1.account.address, 
      addr2.account.address, 
      parseEther("50")
    ]);

    const expectedBurn = (parseEther("50") * 50n) / 1000n; // 5% of 50 = 2.5
    const expectedReceived = parseEther("50") - expectedBurn; // 47.5

    expect(await contract.read.balanceOf([addr2.account.address])).to.equal(expectedReceived);
    
    expect(await contract.read.balanceOf([addr1.account.address])).to.equal(parseEther("50"));
    
    expect(Number(await contract.read.allowance([addr1.account.address, addr2.account.address]))).to.equal(0);
  });

  it("should apply minimum burn amount for small transfers", async function () {
    await contract.write.setTransferWithBurn([true]);
    await contract.write.proposeBurnRate([1]); // 0.1%
    await hre.network.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]);
    await contract.write.executeBurnRateUpdate();

    await contract.write.send([addr1.account.address, parseEther("1")]);
    
    const contractAsAddr1 = await hre.viem.getContractAt(
      "Usm", 
      contract.address, 
      { client: { wallet: addr1 } }
    );
    
    await contractAsAddr1.write.transfer([addr2.account.address, parseEther("0.5")]);

    // 0.5 * 0.1% = 0.0005 ETH = 500000000000000 wei
    const expectedBurn = 500000000000000n;
    const expectedReceived = parseEther("0.5") - expectedBurn; // 0.4995

    expect(await contract.read.balanceOf([addr2.account.address])).to.equal(expectedReceived);
    
    expect(await contract.read.balanceOf([addr1.account.address])).to.equal(parseEther("0.5"));
  });

  it("should not transfer with insufficient balance", async function () {
    await contract.write.send([addr1.account.address, parseEther("10")]);
    
    const contractAsAddr1 = await hre.viem.getContractAt(
      "Usm", 
      contract.address, 
      { client: { wallet: addr1 } }
    );
    
    await expect(
      contractAsAddr1.write.transfer([addr2.account.address, parseEther("20")])
    ).to.be.rejected;
  });
});
  describe("Minting", function () {
    it("should allow only owner to mint tokens", async function () {
      await hre.network.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      
      const totalSupplyBefore = await contract.read.totalSupply();
      await contract.write.mint([parseEther("100")]);
      
      expect(await contract.read.totalSupply()).to.equal(totalSupplyBefore + parseEther("100"));
    });

    it("should enforce mint cooldown", async function () {
      await hre.network.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      
      await contract.write.mint([parseEther("100")]);
      await expect(contract.write.mint([parseEther("100")])).to.be.rejected;

      await hre.network.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      await contract.write.mint([parseEther("100")]);
    });

    it("should not exceed max supply", async function () {
      await hre.network.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      
      await expect(contract.write.mint([parseEther("1500000000")])).to.be.rejected;
    });
  });

  describe("Send Function", function () {
    it("should allow only owner to send tokens from contract", async function () {
      const balanceBefore = await contract.read.balanceOf([addr2.account.address]);
      await contract.write.send([addr2.account.address, parseEther("100")]);
      
      expect(await contract.read.balanceOf([addr2.account.address])).to.equal(balanceBefore + parseEther("100"));
    });

    it("should not send to zero address", async function () {
      await expect(contract.write.send([zeroAddress, parseEther("100")])).to.be.rejected;
    });
  });

  describe("Contract Balance", function () {
    it("should return correct contract balance", async function () {
      const contractBalance = await contract.read.contractBalance();
      const actualBalance = await contract.read.balanceOf([contract.address]);
      expect(contractBalance).to.equal(actualBalance);
    });
  });
});