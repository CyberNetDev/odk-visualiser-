# Déploiement Docker — ODK Visualizer

L'image contient tout ce qu'il faut (Node 20 + ECharts + Leaflet) : l'application fonctionne **sans accès Internet** côté navigateur (seuls les fonds de carte OpenStreetMap ont besoin d'Internet).

## 1. Lancer

```bash
docker compose up -d --build
docker compose ps            # doit afficher "healthy"
docker compose logs -f       # journaux
```

Ouvrir `http://IP-DU-SERVEUR:3000`. L'écran de connexion demande l'**adresse du serveur ODK Central**, l'**e-mail** et le **mot de passe**. Aucun identifiant n'est à mettre dans un fichier.

## 2. Réglages facultatifs

Le fichier `.env` n'est pas obligatoire. Pour l'utiliser : `cp .env.example .env`, puis éditez-le.

| Variable | Rôle |
|---|---|
| `ODK_DEFAULT_URL` | Serveur pré-rempli sur l'écran de connexion |
| `ODK_LOCK_URL=true` | Impose ce serveur : l'utilisateur saisit seulement e-mail et mot de passe |
| `ALLOWED_SERVERS` | Liste blanche de serveurs Central autorisés (séparés par des virgules) |
| `ALLOW_DEMO=false` | Masque le bouton « données de démonstration » |
| `HOST_PORT` | Port publié sur le serveur (défaut 3000) |
| `CACHE_MINUTES` | Durée du cache des soumissions (défaut 5) |

Après modification : `docker compose up -d`.

## 3. Sur le même serveur qu'ODK Central (recommandé)

L'application peut joindre Central par le réseau Docker interne, sans passer par Internet :

```bash
docker network ls | grep central          # en général "central_default"
docker compose -f docker-compose.yml -f docker-compose.central.yml up -d --build
```

Sur l'écran de connexion, utilisez alors l'adresse `http://service:8383`. Vous pouvez aussi la fixer pour tous les utilisateurs dans `.env` :

```
ODK_DEFAULT_URL=http://service:8383
ODK_LOCK_URL=true
```

Si le réseau Docker porte un autre nom : `CENTRAL_NETWORK=nom_du_reseau docker compose -f docker-compose.yml -f docker-compose.central.yml up -d`.

## 4. HTTPS (indispensable en production)

Les mots de passe ODK transitent du navigateur vers l'application : placez-la derrière un reverse proxy HTTPS. Le cookie de session passe automatiquement en mode `Secure`. Exemple Caddy (certificat automatique) :

```
viz.monorg.org {
    reverse_proxy 127.0.0.1:3000
}
```

Exemple nginx :

```nginx
server {
    server_name viz.monorg.org;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 300s;   # gros formulaires
    }
}
```

Dans ce cas, publiez le port uniquement en local : `HOST_PORT=127.0.0.1:3000` dans `.env`.

## 5. Opérations courantes

| Action | Commande |
|---|---|
| Mettre à jour après modification du code | `docker compose up -d --build` |
| Redémarrer | `docker compose restart` |
| Arrêter | `docker compose down` (les visualisations enregistrées sont conservées) |
| Sauvegarder les visualisations | `docker cp odk-visualizer:/app/data/visualizations.json ./backup.json` |
| Restaurer | `docker cp ./backup.json odk-visualizer:/app/data/visualizations.json` |
| Vérifier la santé | `curl http://localhost:3000/api/health` |

## 6. Serveur sans Internet

Construisez l'image sur une machine connectée, puis transférez-la :

```bash
docker save odk-visualizer:latest | gzip > odk-visualizer.tar.gz
# sur le serveur :
gunzip -c odk-visualizer.tar.gz | docker load
docker compose up -d --no-build
```

## Détails de l'image

- Build en 2 étapes ; l'image finale n'a aucune dépendance npm.
- Tourne avec l'utilisateur non-root `node`.
- `HEALTHCHECK` intégré sur `/api/health`.
- Sessions en mémoire : après un redémarrage du conteneur, les utilisateurs se reconnectent.
- Volume `odkvis-data` monté sur `/app/data` pour les visualisations sauvegardées.
- Arrêt propre sur `SIGTERM`, rotation des journaux (3 × 10 Mo).
