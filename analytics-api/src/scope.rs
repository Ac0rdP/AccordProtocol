use std::{collections::HashMap, env};

use anyhow::{Result, bail};
use sqlx::{QueryBuilder, postgres::Postgres};

use crate::proposals::{ErrorDetail, detail, nonempty};

/// Every contract and network this deployment is allowed to serve.
///
/// A single-contract deployment configures `CONTRACT_ID` and `NETWORK` exactly
/// as before; `CONTRACT_IDS` and `NETWORKS` take comma-separated lists so one
/// deployment can serve several multisigs, or the same multisig on testnet and
/// mainnet, without a second process.
#[derive(Clone, Debug)]
pub struct ScopeConfig {
    pub contract_ids: Vec<String>,
    pub networks: Vec<String>,
}

/// The contracts and networks one request is scoped to, after its `contractId`
/// and `network` parameters have been validated against the configuration.
#[derive(Clone, Debug, Default)]
pub struct RequestScope {
    pub contract_ids: Vec<String>,
    pub networks: Vec<String>,
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

impl ScopeConfig {
    pub fn from_env() -> Result<Self> {
        let contract_ids = match env::var("CONTRACT_IDS") {
            Ok(value) => split_list(&value),
            Err(_) => env::var("CONTRACT_ID").map(|value| split_list(&value)).unwrap_or_default(),
        };
        if contract_ids.is_empty() {
            bail!("CONTRACT_ID or CONTRACT_IDS must identify at least one indexed Accord contract");
        }

        let networks = match env::var("NETWORKS") {
            Ok(value) => split_list(&value),
            Err(_) => split_list(&env::var("NETWORK").unwrap_or_else(|_| "testnet".into())),
        };
        if networks.is_empty() {
            bail!("NETWORK or NETWORKS must name at least one network");
        }

        Ok(Self::new(contract_ids, networks))
    }

    pub fn new(contract_ids: Vec<String>, networks: Vec<String>) -> Self {
        Self {
            contract_ids: deduplicate(contract_ids),
            networks: deduplicate(networks),
        }
    }

    /// Narrows the configured scope with a request's `contractId` and `network`
    /// parameters. Unknown values are reported rather than silently widening or
    /// emptying the scope, so a typo never looks like "no data".
    pub fn resolve(
        &self,
        raw: &HashMap<String, String>,
        details: &mut Vec<ErrorDetail>,
    ) -> RequestScope {
        let contract_ids = match nonempty(raw, "contractId") {
            None => self.contract_ids.clone(),
            Some(value) if self.contract_ids.contains(&value) => vec![value],
            Some(_) => {
                details.push(detail(
                    "contractId",
                    "is not a contract served by this deployment",
                    "INVALID_CONTRACT_ID",
                ));
                self.contract_ids.clone()
            }
        };

        let networks = match nonempty(raw, "network") {
            None => self.networks.clone(),
            Some(value) if self.networks.contains(&value) => vec![value],
            Some(_) => {
                details.push(detail(
                    "network",
                    "is not a network served by this deployment",
                    "INVALID_NETWORK",
                ));
                self.networks.clone()
            }
        };

        RequestScope {
            contract_ids,
            networks,
        }
    }

    /// Every (network, contract) pair this deployment serves, in configuration
    /// order. Used by the report scheduler, which runs once per pair.
    pub fn pairs(&self) -> Vec<(String, String)> {
        self.networks
            .iter()
            .flat_map(|network| {
                self.contract_ids
                    .iter()
                    .map(move |contract_id| (network.clone(), contract_id.clone()))
            })
            .collect()
    }
}

/// Appends `AND <alias>contract_id = ANY(...) AND <alias>network = ANY(...)`.
pub fn push_scope<'a>(
    builder: &mut QueryBuilder<'a, Postgres>,
    alias: &str,
    scope: &'a RequestScope,
) {
    builder
        .push(" AND ")
        .push(alias)
        .push("contract_id = ANY(")
        .push_bind(&scope.contract_ids)
        .push(") AND ")
        .push(alias)
        .push("network = ANY(")
        .push_bind(&scope.networks)
        .push(")");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ScopeConfig {
        ScopeConfig::new(
            vec!["CONTRACT_A".into(), "CONTRACT_B".into()],
            vec!["testnet".into(), "pubnet".into()],
        )
    }

    #[test]
    fn defaults_to_every_configured_contract_and_network() {
        let mut details = Vec::new();
        let scope = config().resolve(&HashMap::new(), &mut details);

        assert!(details.is_empty());
        assert_eq!(scope.contract_ids.len(), 2);
        assert_eq!(scope.networks.len(), 2);
    }

    #[test]
    fn narrows_to_one_contract_and_network() {
        let mut details = Vec::new();
        let scope = config().resolve(
            &HashMap::from([
                ("contractId".to_owned(), "CONTRACT_B".to_owned()),
                ("network".to_owned(), "pubnet".to_owned()),
            ]),
            &mut details,
        );

        assert!(details.is_empty());
        assert_eq!(scope.contract_ids, vec!["CONTRACT_B".to_owned()]);
        assert_eq!(scope.networks, vec!["pubnet".to_owned()]);
    }

    #[test]
    fn reports_contracts_and_networks_this_deployment_does_not_serve() {
        let mut details = Vec::new();
        config().resolve(
            &HashMap::from([
                ("contractId".to_owned(), "CONTRACT_Z".to_owned()),
                ("network".to_owned(), "futurenet".to_owned()),
            ]),
            &mut details,
        );

        assert_eq!(details.len(), 2);
    }

    #[test]
    fn enumerates_every_network_and_contract_pair() {
        assert_eq!(config().pairs().len(), 4);
        assert_eq!(
            config().pairs()[0],
            ("testnet".to_owned(), "CONTRACT_A".to_owned())
        );
    }

    #[test]
    fn deduplicates_repeated_configuration_entries() {
        let scope = ScopeConfig::new(
            vec!["A".into(), "A".into(), "B".into()],
            vec!["testnet".into(), "testnet".into()],
        );
        assert_eq!(scope.contract_ids.len(), 2);
        assert_eq!(scope.networks.len(), 1);
    }
}
