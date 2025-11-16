// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract Usm is ERC20, Ownable, ReentrancyGuard, Pausable {
    // Constants
    uint256 private constant MAX_BURN_RATE = 100; // 100%
    uint256 private constant MIN_BURN_AMOUNT = 1;
    uint256 public constant MAX_SUPPLY = 50_000_000_000 * 10**18;
    uint256 public constant MINT_COOLDOWN = 30 days;
    uint256 public constant TIMELOCK_DURATION = 2 days; // 48-hour timelock

    struct TokenInfo {
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        uint256 contractBalance;
        address owner;
        bool isTransferWithBurnEnabled;
        uint256 burnRate;
        bool paused;
        uint256 pendingBurnRate;
        uint256 burnRateUpdateTime;
        bool hasPendingBurnRateUpdate;
    }

    // State variables
    bool public isTransferWithBurnEnabled;
    uint256 public burnRate;
    uint256 public lastMintTime;
    
    // Timelock variables
    uint256 public pendingBurnRate;
    uint256 public burnRateUpdateTime;
    bool public hasPendingBurnRateUpdate;

    // Events
    event Burn(address indexed from, uint256 amount);
    event BurnRateUpdated(uint256 newBurnRate);
    event BurnRateProposed(uint256 proposedBurnRate, uint256 effectiveTime);
    event TransferWithBurnToggled(bool enabled);

    constructor() ERC20("Unified Social Markets", "$USM") Ownable(msg.sender) {
        _mint(address(this), 10_000_000_000 * (10 ** decimals()));
        lastMintTime = block.timestamp;
    }

    /**
     * @notice Returns comprehensive token information
     * @return TokenInfo struct containing all token details
     */
    function getTokenInfo() external view returns (TokenInfo memory) {
        return
            TokenInfo({
                name: name(),
                symbol: symbol(),
                decimals: decimals(),
                totalSupply: totalSupply(),
                contractBalance: balanceOf(address(this)),
                owner: owner(),
                isTransferWithBurnEnabled: isTransferWithBurnEnabled,
                burnRate: burnRate,
                paused: paused(),
                pendingBurnRate: pendingBurnRate,
                burnRateUpdateTime: burnRateUpdateTime,
                hasPendingBurnRateUpdate: hasPendingBurnRateUpdate
            });
    }

    /**
     * @notice Proposes a new burn rate with timelock
     * @param _burnRate The proposed burn rate in thousandths (1/1000), max 500 (50%)
     */
    function proposeBurnRate(uint256 _burnRate) external onlyOwner {
        require(_burnRate <= 100, "Burn rate cannot exceed 10%");
        require(_burnRate != burnRate, "Must be different from current rate");
        
        pendingBurnRate = _burnRate;
        burnRateUpdateTime = block.timestamp + TIMELOCK_DURATION;
        hasPendingBurnRateUpdate = true;
        
        emit BurnRateProposed(_burnRate, burnRateUpdateTime);
    }

    /**
     * @notice Executes the proposed burn rate change after timelock
     */
    function executeBurnRateUpdate() external {
        require(hasPendingBurnRateUpdate, "No pending burn rate update");
        require(block.timestamp >= burnRateUpdateTime, "Timelock not expired");
        require(burnRateUpdateTime > 0, "Update time not set");
        
        burnRate = pendingBurnRate;
        hasPendingBurnRateUpdate = false;
        burnRateUpdateTime = 0;
        
        emit BurnRateUpdated(burnRate);
    }

    /**
     * @notice Cancels a pending burn rate update
     */
    function cancelBurnRateUpdate() external onlyOwner {
        require(hasPendingBurnRateUpdate, "No pending burn rate update");
        
        hasPendingBurnRateUpdate = false;
        pendingBurnRate = 0;
        burnRateUpdateTime = 0;
        
        emit BurnRateUpdated(burnRate); // Emit current rate to indicate cancellation
    }

    /**
     * @notice Enables/disables the transfer with burn functionality
     * @param enabled Boolean to enable or disable burn transfers
     */
    function setTransferWithBurn(bool enabled) external onlyOwner {
        if (enabled) {
            require(burnRate <= 100, "Cannot enable burns with rate > 10%");
            require(!hasPendingBurnRateUpdate || pendingBurnRate <= 100, 
                    "Cannot enable burns with pending high rate");
        }
        isTransferWithBurnEnabled = enabled;
        emit TransferWithBurnToggled(enabled);
    }

    /**
     * @notice Sends tokens from contract to recipient
     * @param to The recipient address
     * @param amount The amount of tokens to send
     */
    function send(
        address to,
        uint256 amount
    ) external onlyOwner returns (bool) {
        require(to != address(0), "Invalid recipient address");
        _transfer(address(this), to, amount);
        return true;
    }

    /**
     * @notice Transfers tokens with optional burn tax
     * @param to The recipient address
     * @param amount The amount of tokens to transfer
     */
    function transfer(
        address to,
        uint256 amount
    ) public override whenNotPaused returns (bool) {
        require(amount > 0, "Amount must be greater than zero");

        (
            uint256 burnAmount,
            uint256 transferAmount
        ) = _calculateTransferAmounts(amount);
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");

        _transfer(msg.sender, to, transferAmount);

        if (burnAmount > 0) {
            _burn(msg.sender, burnAmount);
            emit Burn(msg.sender, burnAmount);
        }

        return true;
    }

    /**
     * @notice Transfers tokens from with optional burn tax
     * @param from The source address
     * @param to The recipient address
     * @param amount The amount of tokens to transfer
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override whenNotPaused returns (bool) {
        require(amount > 0, "Amount must be greater than zero");

        uint256 currentAllowance = allowance(from, msg.sender);
        require(currentAllowance >= amount, "Allowance exceeded");
        require(balanceOf(from) >= amount, "Insufficient balance");

        (
            uint256 burnAmount,
            uint256 transferAmount
        ) = _calculateTransferAmounts(amount);

        _approve(from, msg.sender, currentAllowance - amount);
        _transfer(from, to, transferAmount);

        if (burnAmount > 0) {
            _burn(from, burnAmount);
            emit Burn(from, burnAmount);
        }

        return true;
    }

    /**
     * @notice Internal function to calculate burn and transfer amounts
     * @param amount Original transfer amount
     * @return burnAmount Amount to burn
     * @return transferAmount Amount to actually transfer
     */
    function _calculateTransferAmounts(
        uint256 amount
    ) private view returns (uint256 burnAmount, uint256 transferAmount) {
        if (isTransferWithBurnEnabled && burnRate > 0) {
            burnAmount = (amount * burnRate) / 1000;
            if (burnAmount == 0 && amount > 0) {
                burnAmount = MIN_BURN_AMOUNT;
            }
            require(amount > burnAmount, "Amount too small for burn");
        } else {
            burnAmount = 0;
        }
        transferAmount = amount - burnAmount;
    }

    /**
     * @notice Mints new tokens to the contract
     * @param amount The amount of tokens to mint
     */
    function mint(uint256 amount) external onlyOwner {
        require(block.timestamp >= lastMintTime + MINT_COOLDOWN, "Mint cooldown active");
        require(totalSupply() + amount <= MAX_SUPPLY, "Exceeds max supply");
        lastMintTime = block.timestamp;
        _mint(address(this), amount);
    }

    /**
     * @notice Checks if caller is owner
     * @return Boolean indicating ownership
     */
    function isOwner() external view returns (bool) {
        return msg.sender == owner();
    }

    /**
     * @notice Pauses all transfers
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses all transfers
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Returns the contract's token balance
     * @return Contract balance
     */
    function contractBalance() external view returns (uint256) {
        return balanceOf(address(this));
    }

    /**
     * @notice Calculates the burn amount for a given transfer amount
     * @param amount Transfer amount to calculate burn for
     * @return burnAmount Calculated burn amount
     * @return transferAmount Resulting transfer amount after burn
     */
    function calculateBurnForAmount(
        uint256 amount
    ) external view returns (uint256 burnAmount, uint256 transferAmount) {
        (burnAmount, transferAmount) = _calculateTransferAmounts(amount);
    }

    /**
     * @notice Gets time remaining until burn rate update can be executed
     * @return Time remaining in seconds, 0 if no pending update or timelock expired
     */
    function getTimeUntilBurnRateUpdate() external view returns (uint256) {
        if (!hasPendingBurnRateUpdate || block.timestamp >= burnRateUpdateTime) {
            return 0;
        }
        return burnRateUpdateTime - block.timestamp;
    }
}