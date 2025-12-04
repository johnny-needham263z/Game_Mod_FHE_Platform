pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract GameModFHEPlatform is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    // Custom errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error RateLimited();
    error BatchClosed();
    error BatchFull();
    error InvalidBatch();
    error StaleWrite();
    error InvalidState();
    error ReplayAttempt();

    // Events
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused();
    event Unpaused();
    event CooldownUpdated(uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ModSubmission(address indexed submitter, uint256 indexed batchId, bytes32 indexed cId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionComplete(uint256 indexed requestId, uint256 indexed batchId, uint256 aggregateScore);
    event BatchAggregateCommitted(uint256 indexed batchId, euint32 encryptedAggregate);

    // State
    address public owner;
    bool public paused;
    uint256 public cooldownSeconds;
    uint256 public currentBatchId;
    uint256 public modelVersion;

    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionAt;
    mapping(address => uint256) public lastDecryptionRequestAt;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
        address requester;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Batch {
        bool isActive;
        uint256 submissionCount;
        euint32 encryptedAggregate;
    }
    mapping(uint256 => Batch) public batches;

    // Modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier rateLimited(address caller, mapping(address => uint256) storage lastAction, string memory action) {
        if (block.timestamp < lastAction[caller] + cooldownSeconds) {
            revert RateLimited();
        }
        lastAction[caller] = block.timestamp;
        _;
    }

    modifier batchActive(uint256 batchId) {
        if (!batches[batchId].isActive) revert BatchClosed();
        _;
    }

    // Constructor
    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 30;
        modelVersion = 1;
        currentBatchId = 1;
        _openBatch(currentBatchId);
    }

    // Admin functions
    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function setCooldown(uint256 newCooldown) external onlyOwner {
        cooldownSeconds = newCooldown;
        emit CooldownUpdated(newCooldown);
    }

    function openBatch() external onlyOwner {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner batchActive(batchId) {
        batches[batchId].isActive = false;
        emit BatchClosed(batchId);
    }

    // Helper for batch management
    function _openBatch(uint256 batchId) internal {
        require(batchId == currentBatchId, "Invalid batch ID");
        batches[batchId] = Batch({
            isActive: true,
            submissionCount: 0,
            encryptedAggregate: FHE.asEuint32(0)
        });
        emit BatchOpened(batchId);
    }

    // Core mod submission logic
    function submitMod(
        uint256 batchId,
        euint32 encryptedScore
    )
        external
        onlyProvider
        whenNotPaused
        batchActive(batchId)
        rateLimited(msg.sender, lastSubmissionAt, "submission")
    {
        _requireInitialized(encryptedScore, "encryptedScore");
        Batch storage batch = batches[batchId];

        // Aggregate the encrypted score
        batch.encryptedAggregate = FHE.add(batch.encryptedAggregate, encryptedScore);
        batch.submissionCount++;

        // Emit event with encrypted data only
        bytes32 cId = FHE.toBytes32(encryptedScore);
        emit ModSubmission(msg.sender, batchId, cId);

        // Commit aggregate if batch is full (example: max 10 submissions per batch)
        if (batch.submissionCount >= 10) {
            emit BatchAggregateCommitted(batchId, batch.encryptedAggregate);
            closeBatch(batchId);
            openBatch(); // Open next batch automatically
        }
    }

    // Decryption request for batch aggregate
    function requestBatchDecryption(uint256 batchId)
        external
        onlyProvider
        whenNotPaused
        rateLimited(msg.sender, lastDecryptionRequestAt, "decryption request")
    {
        Batch storage batch = batches[batchId];
        if (!batch.isActive) revert BatchClosed();

        // Prepare ciphertexts for decryption
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(batch.encryptedAggregate);

        // Compute state hash for replay protection
        bytes32 stateHash = _hashCiphertexts(cts);

        // Request decryption
        uint256 requestId = FHE.requestDecryption(cts, this.onBatchDecryptionComplete.selector);

        // Store context for callback
        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false,
            requester: msg.sender
        });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    // Callback for decryption completion
    function onBatchDecryptionComplete(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    )
        public
    {
        DecryptionContext storage context = decryptionContexts[requestId];
        if (context.processed) revert ReplayAttempt();

        // Rebuild ciphertexts from current state
        Batch storage batch = batches[context.batchId];
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(batch.encryptedAggregate);

        // Verify state consistency
        bytes32 currentStateHash = _hashCiphertexts(cts);
        if (currentStateHash != context.stateHash) revert InvalidState();

        // Verify proof
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode cleartext (only aggregate score)
        uint256 aggregateScore = abi.decode(cleartexts, (uint256));

        // Mark as processed and emit
        context.processed = true;
        emit DecryptionComplete(requestId, context.batchId, aggregateScore);
    }

    // Internal helpers
    function _hashCiphertexts(bytes32[] memory cts)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x)
        internal
        returns (euint32)
    {
        if (!FHE.isInitialized(x)) {
            x = FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag)
        internal
        pure
    {
        if (!FHE.isInitialized(x)) {
            revert(string(abi.encodePacked("Uninitialized: ", tag)));
        }
    }
}