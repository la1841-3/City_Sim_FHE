pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract CitySimFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error InvalidState();
    error TooFrequent();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidBatch();
    error InvalidCooldown();
    error InvalidBatchSize();
    error InvalidRequest();
    error InvalidCleartexts();

    bool public paused;
    uint256 public constant MIN_INTERVAL = 5 seconds;
    uint256 public cooldownSeconds = 10;
    uint256 public maxBatchSize = 20;
    uint256 public modelVersion;
    uint256 public currentBatchId;
    bool public batchOpen;

    mapping(address => uint256) public lastActionAt;
    mapping(address => bool) public isProvider;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(address => mapping(uint256 => euint32)) public encryptedCityData;
    mapping(uint256 => euint32) public encryptedBatchAggregates;

    struct DecryptionContext {
        uint256 modelVersion;
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
        address requester;
    }

    struct Batch {
        uint256 id;
        uint256 createdAt;
        uint256 closedAt;
        bool isClosed;
        uint256 submissionCount;
    }

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    event BatchSizeUpdated(uint256 oldSize, uint256 newSize);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PolicySubmitted(address indexed player, uint256 indexed batchId, bytes32 encryptedData);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, address indexed requester);
    event DecryptionComplete(uint256 indexed requestId, uint256 indexed batchId, uint256 totalRevenue, uint256 avgHappiness);

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

    modifier checkCooldown() {
        if (block.timestamp < lastActionAt[msg.sender] + cooldownSeconds) {
            revert TooFrequent();
        }
        lastActionAt[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        modelVersion = 1;
        isProvider[owner] = true;
        currentBatchId = 1;
        batchOpen = false;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldown(uint256 newCooldown) external onlyOwner {
        if (newCooldown < MIN_INTERVAL) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldown;
        emit CooldownUpdated(oldCooldown, newCooldown);
    }

    function setMaxBatchSize(uint256 newSize) external onlyOwner {
        if (newSize == 0) revert InvalidBatchSize();
        uint256 oldSize = maxBatchSize;
        maxBatchSize = newSize;
        emit BatchSizeUpdated(oldSize, newSize);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert BatchNotClosed();
        batchOpen = true;
        batches[currentBatchId] = Batch({
            id: currentBatchId,
            createdAt: block.timestamp,
            closedAt: 0,
            isClosed: false,
            submissionCount: 0
        });
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchClosed();
        batchOpen = false;
        batches[currentBatchId].closedAt = block.timestamp;
        batches[currentBatchId].isClosed = true;
        emit BatchClosed(currentBatchId);
        currentBatchId++;
    }

    function submitEncryptedPolicy(
        uint256 batchId,
        euint32 encryptedTaxRate,
        euint32 encryptedTradeVolume,
        euint32 encryptedHappiness
    ) external onlyProvider whenNotPaused checkCooldown {
        if (batchId != currentBatchId || !batchOpen) revert InvalidBatch();
        Batch storage batch = batches[batchId];
        if (batch.submissionCount >= maxBatchSize) revert InvalidBatchSize();

        _requireInitialized(encryptedTaxRate, "TaxRate");
        _requireInitialized(encryptedTradeVolume, "TradeVolume");
        _requireInitialized(encryptedHappiness, "Happiness");

        euint32 memory revenue = FHE.mul(encryptedTaxRate, encryptedTradeVolume);
        euint32 memory happiness = encryptedHappiness;

        encryptedCityData[msg.sender][batchId] = happiness;

        euint32 memory aggregate = encryptedBatchAggregates[batchId];
        if (!FHE.isInitialized(aggregate)) {
            aggregate = FHE.asEuint32(0);
        }
        aggregate = FHE.add(aggregate, revenue);
        encryptedBatchAggregates[batchId] = aggregate;

        batch.submissionCount++;
        emit PolicySubmitted(msg.sender, batchId, FHE.toBytes32(aggregate));
    }

    function requestBatchDecryption(uint256 batchId) external whenNotPaused checkCooldown {
        if (batchId >= currentBatchId || !batches[batchId].isClosed) revert InvalidBatch();

        euint32 memory aggregate = encryptedBatchAggregates[batchId];
        _requireInitialized(aggregate, "Aggregate");

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(aggregate);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.handleBatchDecryption.selector);

        decryptionContexts[requestId] = DecryptionContext({
            modelVersion: modelVersion,
            batchId: batchId,
            stateHash: stateHash,
            processed: false,
            requester: msg.sender
        });

        emit DecryptionRequested(requestId, batchId, msg.sender);
    }

    function handleBatchDecryption(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert InvalidRequest();

        DecryptionContext storage context = decryptionContexts[requestId];
        euint32 memory currentAggregate = encryptedBatchAggregates[context.batchId];
        _requireInitialized(currentAggregate, "CurrentAggregate");

        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = FHE.toBytes32(currentAggregate);
        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != context.stateHash) revert InvalidState();
        if (context.modelVersion != modelVersion) revert InvalidState();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 totalRevenue;
        assembly {
            totalRevenue := mload(add(cleartexts, 0x20))
        }

        uint256 avgHappiness = totalRevenue / batches[context.batchId].submissionCount;

        context.processed = true;
        emit DecryptionComplete(requestId, context.batchId, totalRevenue, avgHappiness);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal pure returns (euint32 memory) {
        if (!FHE.isInitialized(x)) {
            return FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag) internal pure {
        if (!FHE.isInitialized(x)) {
            revert InvalidState();
        }
    }
}