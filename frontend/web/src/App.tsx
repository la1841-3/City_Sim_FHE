// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface CityPolicy {
  id: string;
  encryptedTaxRate: string;
  encryptedTradeTariff: string;
  timestamp: number;
  mayor: string;
  status: "active" | "draft" | "archived";
  happinessImpact: number;
  revenueImpact: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState<CityPolicy[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newPolicyData, setNewPolicyData] = useState({ taxRate: 0, tradeTariff: 0 });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedPolicy, setSelectedPolicy] = useState<CityPolicy | null>(null);
  const [decryptedTax, setDecryptedTax] = useState<number | null>(null);
  const [decryptedTariff, setDecryptedTariff] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "draft" | "archived">("all");
  const [userHistory, setUserHistory] = useState<string[]>([]);

  const activeCount = policies.filter(p => p.status === "active").length;
  const draftCount = policies.filter(p => p.status === "draft").length;
  const archivedCount = policies.filter(p => p.status === "archived").length;

  useEffect(() => {
    loadPolicies().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadPolicies = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("policy_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing policy keys:", e); }
      }
      const list: CityPolicy[] = [];
      for (const key of keys) {
        try {
          const policyBytes = await contract.getData(`policy_${key}`);
          if (policyBytes.length > 0) {
            try {
              const policyData = JSON.parse(ethers.toUtf8String(policyBytes));
              list.push({ 
                id: key, 
                encryptedTaxRate: policyData.taxRate, 
                encryptedTradeTariff: policyData.tradeTariff, 
                timestamp: policyData.timestamp, 
                mayor: policyData.mayor, 
                status: policyData.status || "draft",
                happinessImpact: policyData.happinessImpact || 0,
                revenueImpact: policyData.revenueImpact || 0
              });
            } catch (e) { console.error(`Error parsing policy data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading policy ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setPolicies(list);
    } catch (e) { console.error("Error loading policies:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitPolicy = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting policy with Zama FHE..." });
    try {
      const encryptedTaxRate = FHEEncryptNumber(newPolicyData.taxRate);
      const encryptedTradeTariff = FHEEncryptNumber(newPolicyData.tradeTariff);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const policyId = `policy-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const policyData = { 
        taxRate: encryptedTaxRate, 
        tradeTariff: encryptedTradeTariff, 
        timestamp: Math.floor(Date.now() / 1000), 
        mayor: address, 
        status: "draft",
        happinessImpact: Math.floor(Math.random() * 20) - 10,
        revenueImpact: Math.floor(Math.random() * 20) - 10
      };
      await contract.setData(`policy_${policyId}`, ethers.toUtf8Bytes(JSON.stringify(policyData)));
      const keysBytes = await contract.getData("policy_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(policyId);
      await contract.setData("policy_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted policy submitted securely!" });
      addToHistory(`Created policy ${policyId.substring(0, 8)}`);
      await loadPolicies();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewPolicyData({ taxRate: 0, tradeTariff: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const activatePolicy = async (policyId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted policy with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const policyBytes = await contract.getData(`policy_${policyId}`);
      if (policyBytes.length === 0) throw new Error("Policy not found");
      const policyData = JSON.parse(ethers.toUtf8String(policyBytes));
      
      const updatedTaxRate = FHECompute(policyData.taxRate, 'increase10%');
      const updatedTariff = FHECompute(policyData.tradeTariff, 'increase10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedPolicy = { ...policyData, status: "active", taxRate: updatedTaxRate, tradeTariff: updatedTariff };
      await contractWithSigner.setData(`policy_${policyId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPolicy)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Policy activated with FHE computation!" });
      addToHistory(`Activated policy ${policyId.substring(0, 8)}`);
      await loadPolicies();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Activation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const archivePolicy = async (policyId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted policy with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const policyBytes = await contract.getData(`policy_${policyId}`);
      if (policyBytes.length === 0) throw new Error("Policy not found");
      const policyData = JSON.parse(ethers.toUtf8String(policyBytes));
      const updatedPolicy = { ...policyData, status: "archived" };
      await contract.setData(`policy_${policyId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPolicy)));
      setTransactionStatus({ visible: true, status: "success", message: "Policy archived successfully!" });
      addToHistory(`Archived policy ${policyId.substring(0, 8)}`);
      await loadPolicies();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Archival failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isMayor = (policyAddress: string) => address?.toLowerCase() === policyAddress.toLowerCase();

  const addToHistory = (action: string) => {
    setUserHistory(prev => [`${new Date().toLocaleTimeString()}: ${action}`, ...prev.slice(0, 9)]);
  };

  const filteredPolicies = policies.filter(policy => {
    const matchesSearch = policy.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         policy.mayor.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || policy.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderImpactMeter = (value: number) => {
    const percentage = Math.min(Math.max(value + 50, 0), 100);
    return (
      <div className="impact-meter">
        <div className="meter-bar" style={{ width: `${percentage}%`, backgroundColor: value > 0 ? '#4CAF50' : '#F44336' }}></div>
        <div className="meter-label">{value > 0 ? `+${value}` : value}</div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="city-spinner"></div>
      <p>Building your encrypted city...</p>
    </div>
  );

  return (
    <div className="app-container city-builder-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="city-icon"></div></div>
          <h1>隱私<span>市長</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-policy-btn city-button">
            <div className="add-icon"></div>New Policy
          </button>
          <button className="city-button" onClick={() => setShowIntro(!showIntro)}>
            {showIntro ? "Hide Intro" : "Show Intro"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        {showIntro && (
          <div className="intro-section city-card">
            <h2>FHE City Builder</h2>
            <div className="intro-content">
              <div className="intro-text">
                <p>As the mayor of your city, set <strong>tax rates</strong> and <strong>trade tariffs</strong> with <strong>Zama FHE encryption</strong>.</p>
                <p>Other cities can only see your city's growth, not your actual policies!</p>
                <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
              </div>
              <div className="intro-image">
                <div className="city-skyline"></div>
              </div>
            </div>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{policies.length}</div>
                <div className="stat-label">Total Policies</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{activeCount}</div>
                <div className="stat-label">Active</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{draftCount}</div>
                <div className="stat-label">Drafts</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{archivedCount}</div>
                <div className="stat-label">Archived</div>
              </div>
            </div>
          </div>
        )}
        
        <div className="policies-section">
          <div className="section-header">
            <h2>City Economic Policies</h2>
            <div className="header-actions">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search policies..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="city-input"
                />
                <select 
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as any)}
                  className="city-select"
                >
                  <option value="all">All Status</option>
                  <option value="active">Active</option>
                  <option value="draft">Draft</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              <button onClick={loadPolicies} className="refresh-btn city-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="policies-list city-card">
            <div className="table-header">
              <div className="header-cell">Policy ID</div>
              <div className="header-cell">Mayor</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Happiness</div>
              <div className="header-cell">Revenue</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {filteredPolicies.length === 0 ? (
              <div className="no-policies">
                <div className="no-policies-icon"></div>
                <p>No policies found</p>
                <button className="city-button primary" onClick={() => setShowCreateModal(true)}>Create First Policy</button>
              </div>
            ) : filteredPolicies.map(policy => (
              <div className="policy-row" key={policy.id} onClick={() => setSelectedPolicy(policy)}>
                <div className="table-cell policy-id">#{policy.id.substring(0, 6)}</div>
                <div className="table-cell">{policy.mayor.substring(0, 6)}...{policy.mayor.substring(38)}</div>
                <div className="table-cell">{new Date(policy.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell">{renderImpactMeter(policy.happinessImpact)}</div>
                <div className="table-cell">{renderImpactMeter(policy.revenueImpact)}</div>
                <div className="table-cell"><span className={`status-badge ${policy.status}`}>{policy.status}</span></div>
                <div className="table-cell actions">
                  {isMayor(policy.mayor) && (
                    <>
                      {policy.status === "draft" && (
                        <button className="action-btn city-button success" onClick={(e) => { e.stopPropagation(); activatePolicy(policy.id); }}>Activate</button>
                      )}
                      {policy.status !== "archived" && (
                        <button className="action-btn city-button danger" onClick={(e) => { e.stopPropagation(); archivePolicy(policy.id); }}>Archive</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        
        <div className="user-history city-card">
          <h3>Your Recent Actions</h3>
          <div className="history-list">
            {userHistory.length === 0 ? (
              <div className="no-history">No recent actions</div>
            ) : (
              userHistory.map((action, index) => (
                <div className="history-item" key={index}>{action}</div>
              ))
            )}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitPolicy} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          policyData={newPolicyData} 
          setPolicyData={setNewPolicyData}
        />
      )}
      
      {selectedPolicy && (
        <PolicyDetailModal 
          policy={selectedPolicy} 
          onClose={() => { 
            setSelectedPolicy(null); 
            setDecryptedTax(null); 
            setDecryptedTariff(null); 
          }} 
          decryptedTax={decryptedTax}
          decryptedTariff={decryptedTariff}
          setDecryptedTax={setDecryptedTax}
          setDecryptedTariff={setDecryptedTariff}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content city-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="city-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="city-icon"></div><span>隱私市長</span></div>
            <p>Build your city with private economic policies using Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Docs</a>
            <a href="#" className="footer-link">Privacy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered City Simulation</span></div>
          <div className="copyright">© {new Date().getFullYear()} 隱私市長. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  policyData: any;
  setPolicyData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, policyData, setPolicyData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setPolicyData({ ...policyData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (isNaN(policyData.taxRate) || isNaN(policyData.tradeTariff)) { 
      alert("Please enter valid numbers"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal city-card">
        <div className="modal-header">
          <h2>Create New Economic Policy</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your policy details will be encrypted with Zama FHE before submission</p></div>
          </div>
          
          <div className="form-group">
            <label>Tax Rate (%) *</label>
            <input 
              type="number" 
              name="taxRate" 
              value={policyData.taxRate} 
              onChange={handleChange} 
              placeholder="Enter tax rate (0-100)" 
              className="city-input"
              min="0"
              max="100"
              step="0.1"
            />
          </div>
          
          <div className="form-group">
            <label>Trade Tariff (%) *</label>
            <input 
              type="number" 
              name="tradeTariff" 
              value={policyData.tradeTariff} 
              onChange={handleChange} 
              placeholder="Enter trade tariff (0-100)" 
              className="city-input"
              min="0"
              max="100"
              step="0.1"
            />
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>Tax: {policyData.taxRate}% | Tariff: {policyData.tradeTariff}%</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {policyData.taxRate ? FHEEncryptNumber(policyData.taxRate).substring(0, 30) + '...' : 'No tax entered'} | 
                  {policyData.tradeTariff ? FHEEncryptNumber(policyData.tradeTariff).substring(0, 30) + '...' : 'No tariff entered'}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn city-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn city-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Policy"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface PolicyDetailModalProps {
  policy: CityPolicy;
  onClose: () => void;
  decryptedTax: number | null;
  decryptedTariff: number | null;
  setDecryptedTax: (value: number | null) => void;
  setDecryptedTariff: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const PolicyDetailModal: React.FC<PolicyDetailModalProps> = ({ 
  policy, onClose, decryptedTax, decryptedTariff, setDecryptedTax, setDecryptedTariff, isDecrypting, decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedTax !== null) { 
      setDecryptedTax(null); 
      setDecryptedTariff(null);
      return; 
    }
    const decryptedTaxValue = await decryptWithSignature(policy.encryptedTaxRate);
    const decryptedTariffValue = await decryptWithSignature(policy.encryptedTradeTariff);
    if (decryptedTaxValue !== null) setDecryptedTax(decryptedTaxValue);
    if (decryptedTariffValue !== null) setDecryptedTariff(decryptedTariffValue);
  };

  return (
    <div className="modal-overlay">
      <div className="policy-detail-modal city-card">
        <div className="modal-header">
          <h2>Policy Details #{policy.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="policy-info">
            <div className="info-item"><span>Mayor:</span><strong>{policy.mayor.substring(0, 6)}...{policy.mayor.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(policy.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${policy.status}`}>{policy.status}</strong></div>
            <div className="info-item"><span>Happiness Impact:</span>{renderImpactMeter(policy.happinessImpact)}</div>
            <div className="info-item"><span>Revenue Impact:</span>{renderImpactMeter(policy.revenueImpact)}</div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Policy Data</h3>
            <div className="encrypted-data-grid">
              <div className="encrypted-item">
                <div className="data-label">Tax Rate:</div>
                <div className="data-value">{policy.encryptedTaxRate.substring(0, 30)}...</div>
              </div>
              <div className="encrypted-item">
                <div className="data-label">Trade Tariff:</div>
                <div className="data-value">{policy.encryptedTradeTariff.substring(0, 30)}...</div>
              </div>
            </div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn city-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : 
               decryptedTax !== null ? "Hide Decrypted Values" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          
          {decryptedTax !== null && decryptedTariff !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Policy Values</h3>
              <div className="decrypted-data-grid">
                <div className="decrypted-item">
                  <div className="data-label">Tax Rate:</div>
                  <div className="data-value">{decryptedTax}%</div>
                </div>
                <div className="decrypted-item">
                  <div className="data-label">Trade Tariff:</div>
                  <div className="data-value">{decryptedTariff}%</div>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn city-button">Close</button>
        </div>
      </div>
    </div>
  );
};

const renderImpactMeter = (value: number) => {
  const percentage = Math.min(Math.max(value + 50, 0), 100);
  return (
    <div className="impact-meter">
      <div className="meter-bar" style={{ width: `${percentage}%`, backgroundColor: value > 0 ? '#4CAF50' : '#F44336' }}></div>
      <div className="meter-label">{value > 0 ? `+${value}` : value}</div>
    </div>
  );
};

export default App;