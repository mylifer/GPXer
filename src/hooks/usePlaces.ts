import { useCallback, useState } from "react";
import { setPlaces as savePlaces, type NamedPlace } from "../api";
import { DEFAULT_RADIUS_M, namedPlaceAt, newPlaceId, setNamedPlaces } from "../places";

/** Adlandırılmış yerler ve "bu yere ad ver" penceresi. */
export function usePlaces(say: (msg: string) => void, fail: (message: string) => void) {
  const [places, setPlacesState] = useState<NamedPlace[]>([]);
  setNamedPlaces(places);
  /** Ad verilecek yer (duraklama/sık durulan yer); yer zaten adlıysa o yer. */
  const [namePrompt, setNamePrompt] = useState<{ lon: number; lat: number; place: NamedPlace | null } | null>(null);

  const updatePlaces = useCallback(
    (next: NamedPlace[]) => {
      setPlacesState(next);
      return savePlaces(next).catch((e) => fail(`Yerler kaydedilemedi: ${e}`));
    },
    [fail],
  );
  const onNamePlace = useCallback((lon: number, lat: number, place: NamedPlace | null) => {
    setNamePrompt({ lon, lat, place: place ?? namedPlaceAt(lon, lat) });
  }, []);
  const namePlace = useCallback(
    (name: string) => {
      const np = namePrompt;
      setNamePrompt(null);
      if (!np) return;
      if (np.place) {
        updatePlaces(places.map((p) => (p.id === np.place!.id ? { ...p, name } : p)));
        say(`Yerin adı “${name}” olarak değiştirildi.`);
      } else {
        updatePlaces([...places, { id: newPlaceId(), name, lat: np.lat, lon: np.lon, radiusM: DEFAULT_RADIUS_M }]);
        say(`“${name}” eklendi (${DEFAULT_RADIUS_M} m yarıçap; Ayarlar'dan değiştirilebilir).`);
      }
    },
    [namePrompt, places, updatePlaces, say],
  );

  return { places, setPlacesState, namePrompt, setNamePrompt, updatePlaces, onNamePlace, namePlace };
}
